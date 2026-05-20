// @ts-nocheck
'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as Tone from 'tone';
import {
  isLoggedIn, loadAllTracks, play, nowPlaying,
  getUserPlaylists, getSelectedPlaylists, saveSelectedPlaylists,
  getCachedTracks, setCachedTracks, clearTracksCache, getCachedPlaylistIds,
  UserPlaylist,
} from '@/lib/spotify-client';
import { loadPrefs, savePrefs, flushPrefs } from '@/lib/preferences';
import { generateCardArt, xmur3 } from '@/lib/card-art';

type Phase = 'init' | 'fetching-playlists' | 'picking' | 'loading-tracks' | 'ready' | 'error';

// How many cards stacked vertically per column. Configurable per-Jukebox via
// the `rows` prop and live-tweakable at runtime via the up/down arrow keys.
const DEFAULT_ROWS = 10;
const MIN_ROWS = 4;
const MAX_ROWS = 20;
const clampRows = (n: number) => Math.max(MIN_ROWS, Math.min(MAX_ROWS, n | 0));
const clampUnit = (n: number) => Math.max(0, Math.min(1, n));
const clampSpin = (n: number) => Math.max(-1.5, Math.min(1.5, n));

export default function Jukebox({
  debug = false,
  rows: initialRows = DEFAULT_ROWS,
}: { debug?: boolean; rows?: number } = {}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('init');
  // Hydrate persisted prefs synchronously so the first render uses the saved
  // row count + the initial scene init uses the saved lighting/spin/etc.
  const initialPrefs = useRef(loadPrefs());
  const [rows, setRows] = useState<number>(
    clampRows(initialPrefs.current.rows ?? initialRows),
  );
  const [loadingMsg, setLoadingMsg] = useState('Loading…');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [userPlaylists, setUserPlaylists] = useState<UserPlaylist[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [showHints, setShowHints] = useState(true);
  const modeRef = useRef<{
    lighting: number; // 0 = classic diner, 1 = roller rink
    zoom: number;     // 0 = fit-to-screen, 1 = zoom-to-cards
    spin: number;     // radians/SECOND auto-orbit (0 = off). Time-based so
                      // the speed stays identical at 60 vs 120 fps displays.
                      // Arrow keys nudge this up/down; defaults to 0.
    debug: boolean;   // procedural tracks, no Spotify API
    showCategories: boolean; // bottom-rim category labels toggled by 'C'
    goToActiveCard?: () => void;
  }>({
    lighting: clampUnit(initialPrefs.current.lighting ?? 1),
    zoom: 0,
    spin: clampSpin(initialPrefs.current.spin ?? 0),
    debug,
    showCategories: initialPrefs.current.showCategories ?? true,
  });
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  // Stash hydrated data here; the initThree effect picks it up once `ready`.
  const tracksDataRef = useRef<{ tracks: any[]; nowItem: any } | null>(null);
  // Set false on unmount so in-flight async hydration doesn't write to a
  // dead component (and doesn't try to re-fetch Spotify after we've torn down).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Boot — always show the picker on refresh, but preselect whatever was used
  // last time. Cached tracks for the same id set will short-circuit the fetch.
  useEffect(() => {
    // Debug shortcut — loads procedural fake tracks instead of hitting Spotify.
    // Available in production too (used by /dev for visual demos / recordings
    // without anyone needing to log in).
    if (debug) {
      void (async () => {
        const m = await import('@/lib/debug-tracks');
        try { await (document as any).fonts?.ready; } catch {}
        if (!mountedRef.current) return;
        tracksDataRef.current = { tracks: m.generateDebugTracks(120), nowItem: null };
        setPhase('ready');
      })();
      return;
    }

    if (!isLoggedIn()) { router.replace('/'); return; }
    setPickedIds(new Set(getSelectedPlaylists()));
    setCachedIds(new Set(getCachedPlaylistIds()));
    void fetchPlaylistsAndPick();
  }, [router, debug]);

  // Mount the Three.js scene once we hit `ready` AND the data is staged.
  // Re-mounts whenever `rows` changes (↑/↓ arrow-key adjustment).
  useEffect(() => {
    if (phase !== 'ready') return;
    const data = tracksDataRef.current;
    if (!data || !containerRef.current) return;
    cleanupRef.current = initThree(
      containerRef.current,
      data.tracks,
      data.nowItem,
      (hasActive) => {
        if (mountedRef.current) setShowHints(!hasActive);
      },
      modeRef.current,
      rows,
    );
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = undefined;
      if (mountedRef.current) setShowHints(true);
    };
  }, [phase, rows]);

  // Keyboard controls (available on every route, suppressed inside form fields).
  //  C       toggle category labels
  //  ←/→     auto-rotation speed
  //  ↑/↓     add / remove a row (triggers scene rebuild)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        modeRef.current.showCategories = !modeRef.current.showCategories;
        savePrefs({ showCategories: modeRef.current.showCategories });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        modeRef.current.spin = Math.min(1.5, modeRef.current.spin + 0.05);
        savePrefs({ spin: modeRef.current.spin });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        modeRef.current.spin = Math.max(-1.5, modeRef.current.spin - 0.05);
        savePrefs({ spin: modeRef.current.spin });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRows(r => { const n = Math.min(MAX_ROWS, r + 1); savePrefs({ rows: n }); return n; });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRows(r => { const n = Math.max(MIN_ROWS, r - 1); savePrefs({ rows: n }); return n; });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Persist the lighting blend on pointer release (initThree mutates
  // modeRef.lighting continuously during a vertical drag; saving on every
  // pointermove would hammer localStorage).
  useEffect(() => {
    const onUp = () => savePrefs({ lighting: modeRef.current.lighting });
    const onHide = () => {
      // Flush any debounced writes before the tab is backgrounded / closed.
      savePrefs({
        lighting: modeRef.current.lighting,
        spin: modeRef.current.spin,
        showCategories: modeRef.current.showCategories,
      });
      flushPrefs();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  async function fetchPlaylistsAndPick() {
    setPhase('fetching-playlists');
    setLoadingMsg('Loading your playlists…');
    try {
      const pls = await getUserPlaylists();
      if (!mountedRef.current) return;
      setUserPlaylists(pls);
      setPhase('picking');
    } catch (e: any) {
      if (!mountedRef.current) return;
      setErrorMsg(e?.message ?? 'Failed to load playlists');
      setPhase('error');
    }
  }

  async function hydrateTracks(ids: string[]) {
    setPhase('loading-tracks');
    setLoadingMsg('Loading tracks…');
    try {
      let data = getCachedTracks(ids);
      if (!data) {
        const fresh = await loadAllTracks(ids);
        if (!mountedRef.current) return;
        setCachedTracks(ids, fresh.tracks, fresh.nowItem);
        data = fresh;
      }
      if (!data.tracks.length) {
        if (!mountedRef.current) return;
        setErrorMsg('No tracks found in the selected playlists.');
        setPhase('error');
        return;
      }
      setLoadingMsg('Building jukebox…');
      // Wait for Google fonts so the canvas card textures render with the
      // intended typefaces instead of falling back to system serifs.
      try { await (document as any).fonts?.ready; } catch {}
      if (!mountedRef.current) return;
      tracksDataRef.current = { tracks: data.tracks, nowItem: data.nowItem };
      setPhase('ready');
    } catch (e: any) {
      if (!mountedRef.current) return;
      setErrorMsg(e?.message ?? 'Failed to load tracks');
      setPhase('error');
    }
  }

  function togglePicked(id: string) {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function confirmSelection() {
    const ids = Array.from(pickedIds);
    if (ids.length === 0) return;
    saveSelectedPlaylists(ids);
    // hydrateTracks consults getCachedTracks first — same id set hits cache,
    // a different set falls through to a fresh fetch and overwrites it.
    void hydrateTracks(ids);
  }

  function flushCache() {
    clearTracksCache();
    setCachedIds(new Set());
  }

  return (
    <>
      {/* Always render the container so the ref is attached before initThree
          runs. Visible only in `ready`; overlays cover it in other phases. */}
      <div
        ref={containerRef}
        id="webgl-container"
        // tabIndex makes it focusable so iPad keyboards send keydown to us
        // instead of the canvas (which would otherwise grab the iOS selection
        // halo). The keydown listener is on window, so any descendant focus
        // works.
        tabIndex={-1}
        style={{ visibility: phase === 'ready' ? 'visible' : 'hidden', outline: 'none' }}
      />
      {phase === 'ready' && (
        <div id="ui-overlay">
          {showHints && (
            <div>
              <div className="instruction-badge">TAP TO PLAY/PAUSE</div>
              <div className="instruction-subtitle">SPIN LEFT/RIGHT • LIGHTING UP/DOWN • PINCH TO ZOOM • C FOR CATS</div>
              <div className="instruction-subtitle">
                ← → ROTATION SPEED &nbsp;•&nbsp; ↑ ↓ ROW COUNT
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'init' && (
        <div className="center-screen">
          <div className="spinner" />
        </div>
      )}
      {(phase === 'fetching-playlists' || phase === 'loading-tracks') && (
        <div className="center-screen">
          <div className="spinner" />
          <div className="loading-text">{loadingMsg}</div>
        </div>
      )}

      {phase === 'error' && (
        <div className="center-screen">
          <div className="loading-text" style={{ color: '#ff6680' }}>{errorMsg}</div>
          <button className="sp-btn" onClick={() => { setErrorMsg(''); setPhase('init'); }}>RETRY</button>
        </div>
      )}

      {phase === 'picking' && (
        <div className="center-screen">
          <div className="modal">
            <div className="modal-title">SELECT PLAYLISTS</div>
            <div className="modal-sub">Pick the playlists to load into the jukebox.</div>
            <ul className="pl-list">
              {userPlaylists.map(pl => {
                const isPicked = pickedIds.has(pl.id);
                const isCached = cachedIds.has(pl.id);
                return (
                  <li key={pl.id} className="pl-row">
                    {pl.image
                      ? <img className="pl-art" src={pl.image} alt="" />
                      : <div className="pl-art pl-art-blank" />}
                    <div className="pl-meta">
                      <div className="pl-name">{pl.name}</div>
                      <div className="pl-id">{pl.id} · {pl.tracks} tracks</div>
                    </div>
                    {isCached && (
                      <button
                        className="cache-chip"
                        onClick={flushCache}
                        title="Tracks for this playlist are cached. Click to clear and refetch."
                      >
                        ● CACHED
                      </button>
                    )}
                    <button
                      className={`sp-btn sp-btn-icon ${isPicked ? 'picked' : ''}`}
                      onClick={() => togglePicked(pl.id)}
                      title={isPicked ? 'Remove' : 'Add'}
                    >
                      {isPicked ? '✓' : '+'}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="modal-actions">
              <button
                className="sp-btn"
                onClick={confirmSelection}
                disabled={pickedIds.size === 0}
              >
                LOAD {pickedIds.size > 0 ? `${pickedIds.size} ` : ''}PLAYLIST{pickedIds.size === 1 ? '' : 'S'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        body {
          overflow: hidden;
          touch-action: none;
          background: radial-gradient(circle at center, #11090c 0%, #000000 100%);
        }
        #webgl-container {
          background: radial-gradient(circle at center, #11090c 0%, #000000 100%);
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          outline: none;
        }
        /* Kill iOS selection halo / context-menu on the canvas — without
           this, tapping the canvas on iPad steals focus and absorbs key
           events. */
        #webgl-container, #webgl-container canvas {
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
          -webkit-tap-highlight-color: transparent;
        }
        #ui-overlay { position: fixed; inset: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; z-index: 10; }
        .instruction-badge {
          background: rgba(20,10,15,0.85);
          color: #00ff88;
          padding: 10px 22px;
          border-radius: 999px;
          border: 2px solid #00ff88;
          font-size: 14px;
          letter-spacing: 2px;
          text-shadow: 0 0 8px rgba(0,255,136,0.5);
          box-shadow: 0 0 18px rgba(0,255,136,0.35);
          line-height: 2em;
        }
          .instruction-subtitle {
          color: #ffffff;
          padding: 10px 22px;
          font-size: 14px;
          text-shadow: 0 0 8px rgba(0,0,0,0.8);
          line-height: 2em;
          }

        .modal {
          background: rgba(10,10,12,0.96);
          border: 2px solid #00ff88;
          border-radius: 12px;
          padding: 24px;
          width: min(560px, 92vw);
          max-height: 80vh;
          display: flex; flex-direction: column; gap: 12px;
          box-shadow: 0 0 30px rgba(0,255,136,0.15);
        }
        .modal-title { color: #00ff88; font-size: 18px; letter-spacing: 3px; text-align: center; }
        .modal-sub { color: #888; font-size: 12px; letter-spacing: 1px; text-align: center; margin-bottom: 4px; }
        .pl-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; border-top: 1px solid rgba(0,255,136,0.18); border-bottom: 1px solid rgba(0,255,136,0.18); }
        .pl-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .cache-chip {
          background: rgba(0,255,136,0.08);
          color: #00ff88;
          border: 1px solid rgba(0,255,136,0.5);
          border-radius: 999px;
          padding: 4px 10px;
          font-family: inherit;
          font-size: 10px;
          letter-spacing: 1px;
          cursor: pointer;
          transition: background-color 0.15s;
        }
        .cache-chip:hover { background: rgba(255,80,80,0.18); color: #ff8080; border-color: #ff8080; }
        .pl-row:last-child { border-bottom: none; }
        .pl-art { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
        .pl-art-blank { background: #222; }
        .pl-meta { flex: 1; min-width: 0; }
        .pl-meta { text-align: left; }
        .pl-name { color: #fff; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pl-id { color: #666; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .modal-actions { display: flex; justify-content: center; margin-top: 4px; }
      `}</style>
    </>
  );
}

function initThree(
  container: HTMLDivElement,
  tracks: any[],
  nowItem: any,
  onActiveChange: (hasActive: boolean) => void,
  mode: { lighting: number; zoom: number; spin: number; debug: boolean; showCategories: boolean; goToActiveCard?: () => void },
  rows: number,
) {
  let audioInitialized = false;
  let beepSynth: any, humSynth: any, humFilter: any;
  async function initAudio() {
    if (audioInitialized) return;
    await Tone.start();
    // Soft triangle-wave chord for the card-select chime. Slight attack ramp
    // avoids the square-wave transient pop the old MembraneSynth produced.
    beepSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.2, release: 1 },
    }).toDestination();
    beepSynth.volume.value = -10;
    humSynth = new Tone.Noise('pink');
    humFilter = new Tone.Filter(150, 'lowpass').toDestination();
    humSynth.connect(humFilter);
    humSynth.volume.value = -25;
    audioInitialized = true;
  }
  function disposeAudio() {
    if (!audioInitialized) return;
    try { humSynth.stop(); } catch {}
    try { humSynth.dispose(); } catch {}
    try { humFilter.dispose(); } catch {}
    try { beepSynth.dispose(); } catch {}
    audioInitialized = false;
  }
  async function playSelectionSound() {
    // Ensure the AudioContext is live (browsers require a user gesture). On
    // the very first tap initAudio still resolves before we trigger the synth.
    await initAudio();
    if (!audioInitialized) return;
    beepSynth.triggerAttackRelease(['C4', 'E4', 'G4'], '8n');
    if (humSynth.state !== 'started') humSynth.start();
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0508, 100, 300);
  scene.background = new THREE.Color(0x0a0508);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 5, 60);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  // Take focus immediately so a hardware keyboard's first arrow / C press
  // works without the user having to tap first.
  try { container.focus({ preventScroll: true }); } catch {}

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minPolarAngle = Math.PI / 2;
  controls.maxPolarAngle = Math.PI / 2;
  controls.enableZoom = false; // we drive zoom ourselves via mode.zoom
  controls.enablePan = false;  // two-finger drag should never pan the camera

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x333333, 0.5);
  scene.add(hemiLight);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.0);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 0.5);
  dirLight.position.set(0, 20, 30);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 10;
  dirLight.shadow.camera.far = 300;
  dirLight.shadow.camera.left = -40;
  dirLight.shadow.camera.right = 40;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  dirLight.shadow.bias = -0.001;
  scene.add(dirLight);
  const cameraLight = new THREE.DirectionalLight(0xffffff, 0.0);
  scene.add(cameraLight);
  scene.add(cameraLight.target);
  const pointLight1 = new THREE.PointLight(0x00ffff, 1.2, 80);
  pointLight1.position.set(-25, 10, 25);
  scene.add(pointLight1);
  const pointLight2 = new THREE.PointLight(0xff00ff, 1.2, 80);
  pointLight2.position.set(25, -10, -25);
  scene.add(pointLight2);

  // Trichromatic fill lights for roller-rink mode — give readable form without
  // a white-out. Modulated by intensity per mode/zoom in animate().
  const fillWhite = new THREE.DirectionalLight(0xffffff, 0.0);
  fillWhite.position.set(0, 30, 50);
  scene.add(fillWhite);
  scene.add(fillWhite.target);
  const fillAmber = new THREE.DirectionalLight(0xffaa55, 0.0);
  fillAmber.position.set(-40, 20, 20);
  scene.add(fillAmber);
  scene.add(fillAmber.target);
  const fillPink = new THREE.DirectionalLight(0xff66cc, 0.0);
  fillPink.position.set(40, 20, 20);
  scene.add(fillPink);
  scene.add(fillPink.target);
  // Amber that orbits with the camera azimuth, lighting the front-facing
  // cards so the center doesn't go black.
  const fillFrontAmber = new THREE.DirectionalLight(0xffaa55, 0.0);
  scene.add(fillFrontAmber);
  scene.add(fillFrontAmber.target);

  // Card grid sized to fit track count. We reserve at least MIN_EMPTY blank
  // slots scattered through the deck; these double as the live queue for
  // incoming now-playing tracks. After reserving empties, round COLS up to
  // even so the alternating teal/aluminum bracket pattern wraps cleanly.
  const ROWS = rows;
  const MIN_EMPTY = 10;
  let COLS = Math.max(8, Math.ceil((tracks.length + MIN_EMPTY) / ROWS));
  if (COLS % 2 === 1) COLS += 1;
  // Larger drums shouldn't whip past — scale rotate speed inversely with COLS
  // so each drag covers a similar number of cards regardless of jukebox size.
  controls.rotateSpeed = Math.max(0.15, Math.min(1.0, 24 / COLS));
  const totalCells = COLS * ROWS;
  const emptyCount = totalCells - tracks.length;
  const displayTracks: (any | null)[] = [...tracks, ...Array(emptyCount).fill(null)];
  for (let i = displayTracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [displayTracks[i], displayTracks[j]] = [displayTracks[j], displayTracks[i]];
  }
  const CARD_W = 3.2;
  const CARD_H = 1.25;
  const ROW_SPACING = 1.4;
  const COL_ANGLE = (Math.PI * 2) / COLS;
  const R = (COLS * (CARD_W + 0.3)) / (2 * Math.PI);
  const startY = (ROWS * ROW_SPACING) / 2 - ROW_SPACING / 2;
  const HEIGHT_TOTAL = ROWS * ROW_SPACING + 4;

  const jukeboxGroup = new THREE.Group();
  scene.add(jukeboxGroup);

  // Floor
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024; floorCanvas.height = 1024;
  const fctx = floorCanvas.getContext('2d')!;
  fctx.fillStyle = '#050505'; fctx.fillRect(0, 0, 1024, 1024);
  fctx.fillStyle = '#e8e8e8';
  for (let i = 0; i < 1024; i += 128) for (let j = 0; j < 1024; j += 128) if ((i / 128 + j / 128) % 2 === 0) fctx.fillRect(i, j, 128, 128);
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = THREE.RepeatWrapping; floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(16, 16);
  floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.1, metalness: 0.4, color: 0xaaaaaa }));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -HEIGHT_TOTAL / 2 - 3;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Env map — seeded so chrome reflections are identical across reloads
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 1024; envCanvas.height = 512;
  const envCtx = envCanvas.getContext('2d')!;
  envCtx.fillStyle = '#050203'; envCtx.fillRect(0, 0, 1024, 512);
  const envSeed = xmur3('jukebox-env');
  const envRnd = () => (envSeed() >>> 0) / 4294967296;
  const envRndInt = (max: number) => Math.floor(envRnd() * max);
  const envColors = ['#00ffff', '#ff00ff', '#ffffff', '#ffaa00'];
  for (let i = 0; i < 30; i++) {
    envCtx.fillStyle = envColors[envRndInt(envColors.length)];
    envCtx.globalAlpha = 0.2 + envRnd() * 0.8;
    envCtx.fillRect(envRnd() * 1024, envRnd() * 512, 100 + envRnd() * 300, 5 + envRnd() * 20);
  }
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = envTex;

  // Hardware
  // Procedural brushed-aluminum texture pair (normal + roughness). Vertical
  // streaks of small random horizontal-tilt perturbations + a matching
  // grayscale roughness variation. Cheap, geometry-free milled-metal look.
  function buildBrushedAluminumMaps() {
    const W = 128, H = 512;

    // Normal map — neutral blue base (128, 128, 255) with per-column X-tilt
    const nc = document.createElement('canvas');
    nc.width = W; nc.height = H;
    const nctx = nc.getContext('2d')!;
    const nimg = nctx.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      // Each vertical streak has a different slight horizontal tilt
      const tilt = (Math.sin(x * 12.9898) * 43758.5453) % 1;
      const r = Math.round(128 + tilt * 30); // X channel
      for (let y = 0; y < H; y++) {
        // Add fine grain noise per pixel for visible scratches
        const grain = (Math.sin(x * 1.7 + y * 0.3) * 2 + Math.sin(y * 5.1) * 1) | 0;
        const i = (y * W + x) * 4;
        nimg.data[i] = Math.max(0, Math.min(255, r + grain));
        nimg.data[i + 1] = 128;       // Y tilt ≈ 0 (no horizontal scratches)
        nimg.data[i + 2] = 250;       // Z (mostly outward)
        nimg.data[i + 3] = 255;
      }
    }
    nctx.putImageData(nimg, 0, 0);
    const normal = new THREE.CanvasTexture(nc);
    normal.wrapS = THREE.RepeatWrapping;
    normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(1, 1);

    // Roughness map — same streak pattern as grayscale so the highlights
    // catch unevenly. Slightly rougher overall than the base mat.
    const rc = document.createElement('canvas');
    rc.width = W; rc.height = H;
    const rctx = rc.getContext('2d')!;
    const rimg = rctx.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      const v = (Math.sin(x * 78.233) * 43758.5453) % 1;
      const base = Math.round(80 + Math.abs(v) * 80);
      for (let y = 0; y < H; y++) {
        const grain = ((Math.sin(x * 0.9 + y * 4.3) * 6) | 0);
        const g = Math.max(0, Math.min(255, base + grain));
        const i = (y * W + x) * 4;
        rimg.data[i] = g; rimg.data[i + 1] = g; rimg.data[i + 2] = g; rimg.data[i + 3] = 255;
      }
    }
    rctx.putImageData(rimg, 0, 0);
    const roughness = new THREE.CanvasTexture(rc);
    roughness.wrapS = THREE.RepeatWrapping;
    roughness.wrapT = THREE.RepeatWrapping;
    roughness.repeat.set(1, 1);

    return { normal, roughness };
  }

  const goldMaterial = new THREE.MeshStandardMaterial({ color: 0xe5b45c, metalness: 1.0, roughness: 0.15 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 1.0, roughness: 0.1 });
  const tealMaterial = new THREE.MeshStandardMaterial({ color: 0x006666, metalness: 0.4, roughness: 0.4 });
  const drumMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.7, roughness: 0.3 });
  // Procedural brushed-aluminum normal + roughness maps. Vertical streaks
  // give the look of milled metal scratches without a single extra vertex —
  // displacement on a 12-vert BoxGeometry would do nothing visible anyway.
  const aluminumMaps = buildBrushedAluminumMaps();
  const aluminumMat = new THREE.MeshStandardMaterial({
    color: 0xaaaaaa,
    metalness: 0.9,
    roughness: 0.55,
    normalMap: aluminumMaps.normal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: aluminumMaps.roughness,
  });
  const whiteBracketMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 0.2, roughness: 0.6 });

  const drumMesh = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, HEIGHT_TOTAL - 1, 64), drumMaterial);
  drumMesh.receiveShadow = true;
  jukeboxGroup.add(drumMesh);
  const rimGeo = new THREE.TorusGeometry(R + 0.2, 0.6, 16, 64);
  const topRim = new THREE.Mesh(rimGeo, goldMaterial);
  topRim.rotation.x = Math.PI / 2; topRim.position.y = HEIGHT_TOTAL / 2;
  topRim.castShadow = true;
  jukeboxGroup.add(topRim);
  const botRim = new THREE.Mesh(rimGeo, goldMaterial);
  botRim.rotation.x = Math.PI / 2; botRim.position.y = -HEIGHT_TOTAL / 2;
  botRim.castShadow = true;
  jukeboxGroup.add(botRim);
  const neonGeo = new THREE.TorusGeometry(R + 1.2, 0.15, 16, 64);
  const neonTop = new THREE.Mesh(neonGeo, new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 2.0 }));
  neonTop.rotation.x = Math.PI / 2; neonTop.position.y = HEIGHT_TOTAL / 2 + 0.5; jukeboxGroup.add(neonTop);
  const neonBot = new THREE.Mesh(neonGeo, new THREE.MeshStandardMaterial({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 2.0 }));
  neonBot.rotation.x = Math.PI / 2; neonBot.position.y = -HEIGHT_TOTAL / 2 - 0.5; jukeboxGroup.add(neonBot);
  jukeboxGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(R + 1.6, R + 1.6, HEIGHT_TOTAL + 2, 64, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.9, clearcoat: 1.0, side: THREE.FrontSide })));

  for (let i = 0; i < COLS; i++) {
    const theta = i * COL_ANGLE;
    const bg = new THREE.Group();
    if (i % 2 === 0) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, HEIGHT_TOTAL - 2, 0.4), tealMaterial);
      base.castShadow = true; base.receiveShadow = true;
      bg.add(base);
      const pL = new THREE.Mesh(new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04), chromeMat); pL.position.set(-0.15, 0, 0.2); bg.add(pL);
      const pR = new THREE.Mesh(new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04), chromeMat); pR.position.set(0.15, 0, 0.2); bg.add(pR);
    } else {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, HEIGHT_TOTAL - 2, 0.15), aluminumMat);
      base.castShadow = true; base.receiveShadow = true;
      bg.add(base);
      const spine = new THREE.Mesh(new THREE.BoxGeometry(0.1, HEIGHT_TOTAL - 2, 0.08), chromeMat); spine.position.set(0, 0, 0.1); bg.add(spine);
    }
    bg.position.set(Math.sin(theta) * (R + 0.12), 0, Math.cos(theta) * (R + 0.12));
    bg.rotation.y = theta;
    jukeboxGroup.add(bg);
  }
  for (let r = 0; r <= ROWS; r++) {
    const y = startY - r * ROW_SPACING + ROW_SPACING / 2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.08, 0.1, 16, 64), whiteBracketMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = y;
    ring.castShadow = true; ring.receiveShadow = true;
    jukeboxGroup.add(ring);
  }

  const ledGeo = new THREE.CylinderGeometry(0.02, 0.02, CARD_W - 0.1, 8);
  ledGeo.rotateZ(Math.PI / 2);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const localLed1 = new THREE.PointLight(0xffd580, 0, 15);
  localLed1.add(new THREE.Mesh(ledGeo, ledMat));
  jukeboxGroup.add(localLed1);
  const localLed2 = new THREE.PointLight(0xffd580, 0, 15);
  localLed2.add(new THREE.Mesh(ledGeo, ledMat));
  jukeboxGroup.add(localLed2);

  // Convergence-tracker LEDs that orbit the top rim. They start from the
  // diametrically-opposite side of the active card and travel in opposite
  // directions to meet at the card — visible from any angle so you can always
  // follow them home to the playing track. Multiple pairs are staggered in
  // time so a tracker is always somewhere on the rim.
  const TRACKER_R = R + 0.2;
  const TRACKER_Y = HEIGHT_TOTAL / 2 + 0.35;
  const TRACKER_PAIRS = 2; // → 4 LEDs total (2 CW + 2 CCW)
  const trackerGeo = new THREE.SphereGeometry(0.18, 16, 16);
  const trackerMat = new THREE.MeshBasicMaterial({ color: 0xffd580 });
  const trackers: { mesh: any; light: any; dir: 1 | -1; offset: number }[] = [];
  for (let i = 0; i < TRACKER_PAIRS; i++) {
    const offset = i / TRACKER_PAIRS; // stagger across the cycle
    for (const dir of [1, -1] as const) {
      const mesh = new THREE.Mesh(trackerGeo, trackerMat);
      const light = new THREE.PointLight(0xffd580, 0, 10);
      mesh.add(light);
      mesh.visible = false;
      jukeboxGroup.add(mesh);
      trackers.push({ mesh, light, dir, offset });
    }
  }

  // Thin Three.js wrapper around the standalone card-art module.
  // Builds a CanvasTexture from the canvas the generator returns.
  function generateCardTexture(song: any) {
    const { canvas, accent, bg, alt } = generateCardArt(song);
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearFilter;
    return { texture, accent, bg, alt };
  }

  const cards: any[] = [];
  // O(1) URI → card lookup; kept in sync with `cards` in buildCard / placeIncoming.
  const cardByUri = new Map<string, any>();
  let activeCard: any = null;
  const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const categories = ['extended play', 'varieties', 'your picks', 'favorites', 'soul', 'popular', 'hit tunes', 'jazz', 'country', 'rock & roll'];

  // All category labels live under this group so the 'C' key toggle can flip
  // them with a single .visible assignment.
  const categoryGroup = new THREE.Group();
  categoryGroup.visible = mode.showCategories;
  jukeboxGroup.add(categoryGroup);

  // Track empty slots (for the queue) and slots already taken by queued cards
  const emptySlots: { c: number; r: number }[] = [];
  const queueCards: any[] = [];

  function buildCard(t: any, c: number, r: number) {
    const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;
    const words = (t.name || '').split(/\s+/).filter(Boolean);
    const half = Math.ceil(words.length / 2);
    const titleA = words.length > 1 ? words.slice(0, half).join(' ') : (t.name || '');
    const titleB = words.length > 1 ? words.slice(half).join(' ') : (t.album || t.name || '');
    const code = letters[c % letters.length] + (r + 1);
    const song = { ...t, titleA, titleB, code };
    const { texture, accent, bg, alt } = generateCardTexture(song);
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
    const card = new THREE.Mesh(cardGeo, mat);
    card.castShadow = true; card.receiveShadow = true;
    const x = Math.sin(theta) * (R + 0.05);
    const z = Math.cos(theta) * (R + 0.05);
    const y = startY - r * ROW_SPACING;
    card.position.set(x, y, z);
    card.rotation.y = theta;
    card.userData = { isCard: true, song, baseY: y, theta, c, r, accentColor: accent, bgColor: bg, altColor: alt };
    return card;
  }

  for (let c = 0; c < COLS; c++) {
    const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;

    const catCanvas = document.createElement('canvas');
    catCanvas.width = 256; catCanvas.height = 64;
    const cctx = catCanvas.getContext('2d')!;
    cctx.fillStyle = '#006666'; cctx.fillRect(0, 0, 256, 64);
    cctx.fillStyle = '#ffffff'; cctx.font = "bold 28px 'Oswald'";
    cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    cctx.fillText(categories[c % categories.length].toUpperCase(), 128, 32);
    // Reactive to scene lighting (Standard material) AND self-illuminated via
    // emissiveMap so each label has its own dim warm glow without spawning a
    // real PointLight per column (that exceeds WebGL's light cap).
    const catTex = new THREE.CanvasTexture(catCanvas);
    const catMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 0.9, 0.6),
      new THREE.MeshStandardMaterial({
        map: catTex,
        emissiveMap: catTex,
        emissive: new THREE.Color(0xffd580),
        emissiveIntensity: 0.35,
        roughness: 0.7,
        metalness: 0.1,
      })
    );
    catMesh.receiveShadow = true;
    catMesh.position.set(Math.sin(theta) * (R + 0.1), -startY - ROW_SPACING, Math.cos(theta) * (R + 0.1));
    catMesh.rotation.y = theta;
    categoryGroup.add(catMesh);

    for (let r = 0; r < ROWS; r++) {
      const idx = c * ROWS + r;
      if (idx >= displayTracks.length) break;
      const t = displayTracks[idx];
      if (!t) { emptySlots.push({ c, r }); continue; }
      const card = buildCard(t, c, r);
      jukeboxGroup.add(card);
      cards.push(card);
      cardByUri.set(card.userData.song.uri, card);
    }
  }

  // Add a new now-playing track. Uses an empty slot if available, otherwise
  // recycles the oldest previously-queued slot. Returns the (existing or new)
  // card for the given URI, or null if none can be placed.
  function placeIncoming(raw: any): any {
    const existing = cardByUri.get(raw.uri);
    if (existing) return existing;
    let slot: { c: number; r: number } | undefined;
    if (emptySlots.length > 0) {
      slot = emptySlots.shift();
    } else {
      // Recycle the oldest queued card — but skip the one that's currently
      // playing (would otherwise dispose its material while still referenced).
      // Rotate it to the back of the queue and try the next.
      while (queueCards.length > 0 && queueCards[0] === activeCard) {
        queueCards.push(queueCards.shift());
      }
      if (queueCards.length > 0) {
        const oldest = queueCards.shift();
        slot = { c: oldest.userData.c, r: oldest.userData.r };
        jukeboxGroup.remove(oldest);
        cards.splice(cards.indexOf(oldest), 1);
        cardByUri.delete(oldest.userData.song.uri);
        try { (oldest.material as any).map?.dispose?.(); (oldest.material as any).dispose?.(); } catch {}
      }
    }
    if (!slot) return null;
    const card = buildCard(raw, slot.c, slot.r);
    jukeboxGroup.add(card);
    cards.push(card);
    cardByUri.set(card.userData.song.uri, card);
    queueCards.push(card);
    return card;
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Card the LEDs are currently parked at. When this differs from activeCard,
  // the animate loop fades them out, repositions them, then fades them back in
  // at the new card — no flicker from an instant jump.
  let ledCard: any = null;
  function ledMoveTo(card: any) {
    const data = card.userData;
    const yTop = data.baseY + CARD_H / 2 - 0.02;
    const yBot = data.baseY - CARD_H / 2 + 0.02;
    localLed1.position.set(Math.sin(data.theta) * (R + 0.14), yTop, Math.cos(data.theta) * (R + 0.14));
    localLed1.rotation.y = data.theta;
    localLed2.position.set(Math.sin(data.theta) * (R + 0.14), yBot, Math.cos(data.theta) * (R + 0.14));
    localLed2.rotation.y = data.theta;
  }

  // Bring the playing track to life. Finds (or places via the queue) the card
  // for the given Spotify item, sets it as active, and jumps the drum front-and-center.
  function syncNowPlaying(item: any) {
    if (!item?.uri) return;
    let match = cardByUri.get(item.uri);
    if (!match) {
      match = placeIncoming({
        uri: item.uri,
        name: item.name,
        artist: (item.artists || []).map((a: any) => a.name).join(', '),
        album: item.album?.name ?? '',
        source: 'now',
      });
    }
    if (!match || match === activeCard) return;
    activeCard = match;
    onActiveChange(true);
    mode.goToActiveCard?.();
  }

  async function selectCard(card: any) {
    if (activeCard === card) {
      activeCard = null;
      onActiveChange(false);
      return;
    }
    playSelectionSound();
    activeCard = card;
    onActiveChange(true);
    // Skip the API call for fake debug URIs.
    if (!mode.debug) {
      try { await play(card.userData.song.uri); } catch {}
    }
  }

  // Tap/drag/pinch handling:
  //  • Tap (move <DRAG_THRESHOLD px in <500ms) → card / button
  //  • Single-finger vertical drag → mode.lighting
  //  • Single-finger horizontal drag → OrbitControls rotation
  //  • Two-finger pinch → mode.zoom (mobile equivalent of mouse wheel)
  //  • Double-tap on chrome → snap zoom max/min
  const DRAG_THRESHOLD = 6;
  const DOUBLE_TAP_MS = 350;
  let downX = 0, downY = 0, downAt = 0, lastY = 0, isDragging = false;
  let lastTapAt = 0;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchBaseDist = 0;
  let pinchBaseZoom = 0;
  let isPinching = false;
  function getXY(event: PointerEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  function onPointerDown(event: any) {
    initAudio();
    // Pull focus back to our container so the canvas / iOS selection halo
    // doesn't steal keyboard input from us.
    container.focus({ preventScroll: true });
    const { x, y } = getXY(event);
    if (event.pointerId !== undefined) activePointers.set(event.pointerId, { x, y });
    downX = x; downY = y; lastY = y; downAt = Date.now();
    isDragging = true;
    if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      pinchBaseDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchBaseZoom = mode.zoom;
      isPinching = true;
      controls.enabled = false; // freeze drum rotation while pinching
    }
  }
  function onPointerMove(event: any) {
    if (!isDragging) return;
    const { x, y } = getXY(event);
    if (event.pointerId !== undefined) activePointers.set(event.pointerId, { x, y });

    if (isPinching && activePointers.size >= 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = dist / Math.max(pinchBaseDist, 1);
      // Spread → zoom in; pinch → zoom out. Scale 1× of dist change ≈ full range.
      mode.zoom = clamp(pinchBaseZoom + (ratio - 1), 0, 1);
      lastY = y; // keep lastY current so lighting doesn't jump after pinch ends
      return;
    }

    const dy = y - lastY;
    lastY = y;
    mode.lighting = clamp(mode.lighting - dy * 0.003, 0, 1);
  }
  function onPointerUp(event: any) {
    if (event.pointerId !== undefined) activePointers.delete(event.pointerId);
    if (activePointers.size < 2 && isPinching) {
      isPinching = false;
      controls.enabled = true;
    }
    if (activePointers.size > 0) return; // wait for all fingers to lift
    isDragging = false;
    const { x, y } = getXY(event);
    const dx = x - downX, dy = y - downY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) return;
    if (Date.now() - downAt > 500) return;
    mouse.x = (x / window.innerWidth) * 2 - 1;
    mouse.y = -(y / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(cards);
    if (hits.length) { selectCard(hits[0].object); lastTapAt = 0; return; }
    // Empty space (chrome / background) — detect double tap → toggle zoom
    const now = Date.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      mode.zoom = mode.zoom > 0.5 ? 0 : 1;
      lastTapAt = 0;
    } else {
      lastTapAt = now;
    }
  }
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  // Scroll wheel drives zoom (0 = fit, 1 = tight on cards). Track-pad pinch
  // also produces wheel events with ctrlKey set.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const step = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.0025;
    mode.zoom = clamp(mode.zoom + step, 0, 1);
  }
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // Viewport sync. iPadOS in particular doesn't reliably fire `resize` when
  // the app is backgrounded and reopened — the canvas stays at whatever
  // dimensions Safari thought the page was during minimization (often half-
  // width). We re-measure on every visibility/pageshow/orientation event and
  // defer the actual setSize with rAF so the visualViewport has finished
  // animating before we read from it.
  function applySize() {
    // visualViewport is more accurate than innerWidth during iOS restore
    // animations (innerWidth can lie for a few frames).
    const vv = (window as any).visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);
    if (w <= 0 || h <= 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, true);
  }
  let resizeRaf = 0;
  function scheduleResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      applySize();
      // One more on the next frame — covers cases where the first rAF still
      // saw an in-flight transition (iPad split-view, Stage Manager).
      requestAnimationFrame(applySize);
    });
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') scheduleResize();
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  window.addEventListener('pageshow', scheduleResize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  (window as any).visualViewport?.addEventListener('resize', scheduleResize);

  // Poll now-playing. syncNowPlaying handles deck lookup, queue placement,
  // LED positioning, and the jump-to-card camera move. Skipped in debug mode
  // (the URIs are fake, the Spotify API would 4xx).
  const pollInterval: ReturnType<typeof setInterval> | null = mode.debug
    ? null
    : setInterval(async () => {
        try {
          const d = await nowPlaying();
          if (d?.item) syncNowPlaying(d.item);
        } catch {}
      }, 8000);

  // Smooth jukebox-drum rotation to bring the active card front-and-center.
  // We rotate the group (not the camera) — OrbitControls' damping fights direct
  // camera position writes and produces no visible movement.
  let groupRotTarget: number | null = null;
  mode.goToActiveCard = () => {
    if (!activeCard) return;
    const curAz = controls.getAzimuthalAngle();
    // Card's world angle = card.theta + jukeboxGroup.rotation.y.
    // We want world angle == curAz so card faces the camera.
    groupRotTarget = curAz - activeCard.userData.theta;
    mode.isAutoTransitioning = false;
  };
  controls.addEventListener('start', () => { groupRotTarget = null; });

  // Startup choreography:
  //   t+0:    illuminate the now-playing track + jump-to-card
  //   t+4s:   ramp zoom up to 1 (tight on the playing card); the per-frame
  //           camera lerp animates the actual zoom-in smoothly.
  let isSceneReady = false;
  const introTimers: ReturnType<typeof setTimeout>[] = [];
  function onSceneReady() {
    if (nowItem) {
      activeCard = null;
      syncNowPlaying(nowItem);
    }
    introTimers.push(setTimeout(() => {
      mode.zoom = 1;
      if (activeCard) mode.goToActiveCard?.();
    }, 4000));
  }

  const clock = new THREE.Clock();
  let raf = 0;

  // Scratch objects reused across frames to avoid 20+ allocations/frame.
  const _camOffset = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _camTarget = new THREE.Vector3();
  const _camLerpTarget = new THREE.Vector3();
  const _origin = new THREE.Vector3(0, 0, 0);
  const _tColor1 = new THREE.Color();
  const _tColor2 = new THREE.Color();
  const _dColor1 = new THREE.Color(0xffeedd);
  const _dColor2 = new THREE.Color(0xaaeeff);
  const _rColor1 = new THREE.Color();
  const _rColor2 = new THREE.Color();
  const _scratchA = new THREE.Color();
  const _scratchB = new THREE.Color();
  const _scratchC = new THREE.Color();
  const _ambientWarm = new THREE.Color(0xffb060);
  const _camLightWarm = new THREE.Color(0xffb878);
  const _ledBase = new THREE.Color(0xffd580);
  const _ledTgt = new THREE.Color();

  function animate() {
    raf = requestAnimationFrame(animate);
    if (!isSceneReady) {
      isSceneReady = true;
      onSceneReady();
    }

    // Polar angle vs zoom: zoomed out → slight top-down tilt (spin7 fit mode);
    // zoomed in → lock to horizontal scroll only.
    const targetMinPolar = Math.PI / 2 + (Math.PI / 6 - Math.PI / 2) * (1 - mode.zoom);
    const targetMaxPolar = Math.PI / 2 + 0.1 * (1 - mode.zoom);
    controls.minPolarAngle += (targetMinPolar - controls.minPolarAngle) * 0.1;
    controls.maxPolarAngle += (targetMaxPolar - controls.maxPolarAngle) * 0.1;
    if (controls.minPolarAngle > controls.maxPolarAngle) controls.minPolarAngle = controls.maxPolarAngle;

    // Spin the drum to bring the active card front-and-center
    if (groupRotTarget !== null) {
      let delta = groupRotTarget - jukeboxGroup.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) < 0.002) {
        jukeboxGroup.rotation.y = groupRotTarget;
        groupRotTarget = null;
      } else {
        jukeboxGroup.rotation.y += delta * 0.1;
      }
    }

    // Auto-orbit (driven by ←/→ arrow keys, default 0 = off). Rotating the
    // camera around the jukebox — instead of spinning the jukeboxGroup — lets
    // the direction-tracking lights (dirLight, fillFrontAmber) follow along.
    // Time-based delta keeps the speed identical on 60 Hz and 120 Hz displays.
    if (mode.spin) {
      const dt = clock.getDelta();
      const az = controls.getAzimuthalAngle() + mode.spin * dt;
      const r = Math.hypot(camera.position.x, camera.position.z);
      camera.position.x = Math.sin(az) * r;
      camera.position.z = Math.cos(az) * r;
    }

    controls.update();
    if (categoryGroup.visible !== mode.showCategories) categoryGroup.visible = mode.showCategories;

    const dist = camera.position.length();
    scene.fog.near = dist + 30; scene.fog.far = dist + 250;

    // Continuous zoom: 0 = fit-to-screen (wide FOV, full jukebox in view),
    // 1 = zoom-to-cards (telephoto FOV, height-fit on the cards).
    // Camera FOV + position smoothly lerp toward targets derived from mode.zoom.
    {
      const z = mode.zoom;
      const targetFOV = 45 + (12 - 45) * z;
      camera.fov += (targetFOV - camera.fov) * 0.12;
      camera.updateProjectionMatrix();
      const vFOV = (camera.fov * Math.PI) / 180;
      const hDist = (HEIGHT_TOTAL + 1) / (2 * Math.tan(vFOV / 2));
      const wDist = (R * 2 + 4) / (2 * Math.tan(vFOV / 2) * camera.aspect);
      const fitDist = Math.max(hDist, wDist);
      // At max zoom, pull in past the strict height-fit so cards punch larger
      // in frame (FOV compression alone doesn't change apparent card size).
      const tightDist = hDist * 0.95;
      const targetDist = fitDist + (tightDist - fitDist) * z;
      const azi = controls.getAzimuthalAngle();
      const tx = Math.sin(azi) * (R + targetDist);
      const tz = Math.cos(azi) * (R + targetDist);
      _camLerpTarget.set(tx, 0, tz);
      camera.position.lerp(_camLerpTarget, 0.12);
      controls.target.lerp(_origin, 0.12);
    }

    // Offset the camera headlight to the right of the camera (relative to its
    // view direction), then aim it at the focal point. This grazes the cards
    // from the side instead of blowing out the center.
    _camOffset.subVectors(controls.target, camera.position);
    _camRight.crossVectors(_camOffset, camera.up).normalize();
    const offsetDist = _camOffset.length() * 0.6;
    cameraLight.position.copy(camera.position).addScaledVector(_camRight, offsetDist);
    cameraLight.target.position.copy(controls.target);

    const t = clock.getElapsedTime();

    // Continuous lighting blend: L=0 diner, L=1 rink. Compute both endpoints,
    // lerp by L. Fill lights ramp with the rink share.
    const z = mode.zoom;
    const L = mode.lighting;
    const ftt = (fit: number, tight: number) => fit + (tight - fit) * z;

    fillWhite.intensity += ((L * 0.35) - fillWhite.intensity) * 0.05;
    fillAmber.intensity += ((L * 0.45) - fillAmber.intensity) * 0.05;
    fillPink.intensity += ((L * 0.45) - fillPink.intensity) * 0.05;
    fillFrontAmber.intensity += ((L * 0.55) - fillFrontAmber.intensity) * 0.05;

    // Diner endpoint
    const dHemi = ftt(0.45, 0.0);
    const dDir = ftt(0.75, 0.0);
    const dAmb = ftt(0.0, 0.55);
    const dCam = ftt(0.0, 0.2);

    // Rink endpoint — moody, optionally driven by the active card's palette
    let rHemi: number, rDir: number;
    if (activeCard) {
      _scratchA.set(activeCard.userData.accentColor);
      _scratchB.set(activeCard.userData.bgColor);
      _scratchC.set(activeCard.userData.altColor || '#ffffff');
      const cycle = (Math.sin(t * 1.5) + 1) / 2;
      _rColor1.lerpColors(_scratchA, _scratchB, cycle);
      _rColor2.lerpColors(_scratchB, _scratchC, 1 - cycle);
      rHemi = ftt(0.1, 0.0);
      rDir = ftt(0.1, 0.0);
    } else {
      _rColor1.setHSL((t * 0.1) % 1, 0.9, 0.6);
      _rColor2.setHSL(((t * 0.1) + 0.5) % 1, 0.9, 0.6);
      rHemi = ftt(0.4, 0.0);
      rDir = ftt(0.6, 0.0);
    }

    const targetHemi = dHemi * (1 - L) + rHemi * L;
    const targetDir = dDir * (1 - L) + rDir * L;
    const targetAmbient = dAmb * (1 - L); // rink contributes 0
    const targetCamLight = dCam * (1 - L);
    hemiLight.intensity += (targetHemi - hemiLight.intensity) * 0.05;
    dirLight.intensity += (targetDir - dirLight.intensity) * 0.05;
    ambientLight.intensity += (targetAmbient - ambientLight.intensity) * 0.05;
    ambientLight.color.lerp(_ambientWarm, 0.05);
    cameraLight.intensity += (targetCamLight - cameraLight.intensity) * 0.05;
    cameraLight.color.lerp(_camLightWarm, 0.05);

    _tColor1.lerpColors(_dColor1, _rColor1, L);
    _tColor2.lerpColors(_dColor2, _rColor2, L);

    const az = controls.getAzimuthalAngle();
    dirLight.position.set(Math.sin(az) * 100, 100, Math.cos(az) * 100);
    // Position the amber up and ~70° off to the right of the camera, aimed at
    // origin → light travels diagonally down from upper-right to lower-left
    // across the cards. Grazes instead of washing.
    const azOff = az + Math.PI / 2.5;
    fillFrontAmber.position.set(Math.sin(azOff) * 35, 22, Math.cos(azOff) * 35);
    pointLight1.color.lerp(_tColor1, 0.03);
    neonTop.material.color.lerp(_tColor1, 0.03);
    neonTop.material.emissive.lerp(_tColor1, 0.03);
    pointLight2.color.lerp(_tColor2, 0.03);
    neonBot.material.color.lerp(_tColor2, 0.03);
    neonBot.material.emissive.lerp(_tColor2, 0.03);
    if (activeCard) {
      // Cross-fade LEDs when the active card changes: fade out at the old
      // location, jump to the new location while dark, fade back in. No more
      // flicker from an instant teleport.
      if (ledCard !== activeCard) {
        // Fading out
        localLed1.intensity += (0 - localLed1.intensity) * 0.2;
        localLed2.intensity += (0 - localLed2.intensity) * 0.2;
        if (localLed1.intensity < 0.05) {
          ledMoveTo(activeCard);
          ledCard = activeCard;
        }
      } else {
        // Parked at the right card — fade in
        localLed1.intensity += (5.0 - localLed1.intensity) * 0.1;
        localLed2.intensity += (5.0 - localLed2.intensity) * 0.1;
      }
      _scratchA.set(activeCard.userData.accentColor);
      _ledTgt.copy(_ledBase).lerp(_scratchA, 0.15);
      ledMat.color.lerp(_ledTgt, 0.1);
      localLed1.color.lerp(_ledTgt, 0.1);
      localLed2.color.lerp(_ledTgt, 0.1);

      // Multiple staggered tracker pairs sweep both directions on the rim.
      const TRACKER_SPEED = 0.4; // cycles per second
      const thetaActive = activeCard.userData.theta;
      for (const tr of trackers) {
        tr.mesh.visible = true;
        const progress = (t * TRACKER_SPEED + tr.offset) % 1;
        const ang = thetaActive + tr.dir * Math.PI * (1 - progress);
        tr.mesh.position.set(Math.sin(ang) * TRACKER_R, TRACKER_Y, Math.cos(ang) * TRACKER_R);
        tr.light.intensity = 3 + Math.sin(progress * Math.PI) * 4;
        tr.light.color.lerp(_ledTgt, 0.1);
      }
      trackerMat.color.lerp(_ledTgt, 0.1);
    } else {
      localLed1.intensity += -localLed1.intensity * 0.1;
      localLed2.intensity += -localLed2.intensity * 0.1;
      if (localLed1.intensity < 0.05) ledCard = null;
      for (const tr of trackers) {
        tr.mesh.visible = false;
        tr.light.intensity = 0;
      }
    }
    cards.forEach((c) => {
      const tgt = activeCard === c ? 0.3 : 0;
      c.material.emissiveIntensity += (tgt - c.material.emissiveIntensity) * 0.1;
    });
    renderer.render(scene, camera);
  }
  animate();

  return () => {
    cancelAnimationFrame(raf);
    if (pollInterval !== null) clearInterval(pollInterval);
    introTimers.forEach(clearTimeout);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('resize', scheduleResize);
    window.removeEventListener('orientationchange', scheduleResize);
    window.removeEventListener('pageshow', scheduleResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    (window as any).visualViewport?.removeEventListener('resize', scheduleResize);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    renderer.domElement.removeEventListener('wheel', onWheel);
    disposeAudio();

    // Walk the scene graph and dispose every GPU resource. WebGL leaks
    // textures/buffers per route change without this — renderer.dispose()
    // alone only frees the GL context.
    scene.traverse((obj: any) => {
      if (obj.geometry?.dispose) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const m of mats) {
        for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'envMap']) {
          if (m[k]?.dispose) m[k].dispose();
        }
        if (m.dispose) m.dispose();
      }
    });
    if ((scene as any).environment?.dispose) (scene as any).environment.dispose();
    if ((scene as any).background?.dispose) (scene as any).background.dispose();
    renderer.dispose();
    container.removeChild(renderer.domElement);
  };
}
