// @ts-nocheck
'use client';
import { useEffect, useRef, useState } from 'react';
import {
  isLoggedIn, login, loadAllTracks, play, nowPlaying,
  getStoredClientId, setStoredClientId,
  getUserPlaylists, getSelectedPlaylists, saveSelectedPlaylists,
  getCachedTracks, setCachedTracks, clearTracksCache, getCachedPlaylistIds,
  UserPlaylist,
} from '@/lib/spotify-client';

const SCRIPTS = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
  'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js',
];

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`load failed: ${src}`));
    document.head.appendChild(s);
  });
}

type Phase = 'init' | 'unauthed' | 'fetching-playlists' | 'picking' | 'loading-tracks' | 'ready' | 'error';

function ClientIdForm() {
  const [clientId, setClientId] = useState('');
  useEffect(() => { setClientId(getStoredClientId()); }, []);
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStoredClientId(clientId);
    login();
  };
  return (
    <form
      onSubmit={onSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 'min(360px, 86vw)' }}
    >
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="Spotify Client ID"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        style={{
          background: 'rgba(20,10,15,0.85)',
          color: '#fff',
          border: '2px solid rgba(0,255,136,0.35)',
          borderRadius: 8,
          padding: '10px 14px',
          fontFamily: 'inherit',
          fontSize: 13,
          letterSpacing: 1,
          textAlign: 'center',
          outline: 'none',
        }}
      />
      <button className="sp-btn" type="submit">LOGIN WITH SPOTIFY</button>
      <div style={{ fontSize: 11, color: '#888', letterSpacing: 0.5, paddingTop: 4 }}>
        Create a Spotify app to get a Client ID (free, ~1 minute).
        {' '}
        <a
          href="https://github.com/spacedevin/juke.sh/blob/main/USER_GUIDE.md"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#00ff88', textDecoration: 'none' }}
        >
          How →
        </a>
      </div>
    </form>
  );
}

export default function Jukebox({ demo = false }: { demo?: boolean } = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('init');
  const [loadingMsg, setLoadingMsg] = useState('Loading…');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [userPlaylists, setUserPlaylists] = useState<UserPlaylist[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [npText, setNpText] = useState('Loading…');
  const [npIdle, setNpIdle] = useState(true);
  const setBanner = (text: string, idle = false) => { setNpText(text); setNpIdle(idle); };
  const modeRef = useRef<{
    lighting: number; // 0 = classic diner, 1 = roller rink
    zoom: number;     // 0 = fit-to-screen, 1 = zoom-to-cards
    demoSpin: number; // radians/frame to auto-rotate the drum (0 = off)
    goToActiveCard?: () => void;
  }>({ lighting: 1, zoom: 0, demoSpin: demo ? 0.003 : 0 });
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  // Stash hydrated data here; the initThree effect picks it up once `ready`.
  const tracksDataRef = useRef<{ tracks: any[]; nowItem: any } | null>(null);

  // Boot — always show the picker on refresh, but preselect whatever was used
  // last time. Cached tracks for the same id set will short-circuit the fetch.
  useEffect(() => {
    if (!isLoggedIn()) { setPhase('unauthed'); return; }
    setPickedIds(new Set(getSelectedPlaylists()));
    setCachedIds(new Set(getCachedPlaylistIds()));
    void fetchPlaylistsAndPick();
  }, []);

  // Mount the Three.js scene once we hit `ready` AND the data is staged.
  useEffect(() => {
    if (phase !== 'ready') return;
    const data = tracksDataRef.current;
    if (!data || !containerRef.current) return;
    cleanupRef.current = initThree(
      containerRef.current, data.tracks, data.nowItem, setBanner, modeRef.current,
    );
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = undefined;
    };
  }, [phase]);

  async function fetchPlaylistsAndPick() {
    setPhase('fetching-playlists');
    setLoadingMsg('Loading your playlists…');
    try {
      const pls = await getUserPlaylists();
      setUserPlaylists(pls);
      setPhase('picking');
    } catch (e: any) {
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
        setCachedTracks(ids, fresh.tracks, fresh.nowItem);
        data = fresh;
      }
      if (!data.tracks.length) {
        setErrorMsg('No tracks found in the selected playlists.');
        setPhase('error');
        return;
      }
      setLoadingMsg('Building jukebox…');
      for (const src of SCRIPTS) await loadScript(src);
      try { await (document as any).fonts?.ready; } catch {}
      tracksDataRef.current = { tracks: data.tracks, nowItem: data.nowItem };
      setPhase('ready');
    } catch (e: any) {
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
        style={{ visibility: phase === 'ready' ? 'visible' : 'hidden' }}
      />
      {phase === 'ready' && (
        <div id="ui-overlay">
          {npIdle && <div>
            <div className="instruction-badge">TAP TO PLAY/PAUSE</div>
            <div className="instruction-subtitle">SPIN LEFT/RIGHT • LIGHTING UP/DOWN • PINCH TO ZOOM</div>
            </div>}
        </div>
      )}

      {phase === 'init' && (
        <div className="center-screen">
          <div className="spinner" />
        </div>
      )}
      {phase === 'unauthed' && (
        <div className="center-screen">
          <ClientIdForm />
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
        body { overflow: hidden; touch-action: none; }
        #webgl-container { background: black; position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
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
  setBanner: (text: string, idle?: boolean) => void,
  mode: { lighting: number; zoom: number; demoSpin: number; goToActiveCard?: () => void }
) {
  const THREE = (window as any).THREE;
  const Tone = (window as any).Tone;

  let audioInitialized = false;
  let clunkSynth: any, beepSynth: any, humSynth: any;
  async function initAudio() {
    if (audioInitialized) return;
    await Tone.start();
    clunkSynth = new Tone.MembraneSynth({ pitchDecay: 0.01, octaves: 2, oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 } }).toDestination();
    clunkSynth.volume.value = -5;
    beepSynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.05, decay: 0.2, sustain: 0.2, release: 1 } }).toDestination();
    beepSynth.volume.value = -12;
    humSynth = new Tone.Noise('pink');
    const lp = new Tone.Filter(150, 'lowpass').toDestination();
    humSynth.connect(lp);
    humSynth.volume.value = -25;
    audioInitialized = true;
  }
  function playSelectionSound() {
    if (!audioInitialized) return;
    clunkSynth.triggerAttackRelease('G1', '16n');
    setTimeout(() => beepSynth.triggerAttackRelease(['C4', 'E4', 'G4'], '8n'), 150);
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

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxDistance = 300;
  controls.minDistance = 22;
  controls.minPolarAngle = Math.PI / 2;
  controls.maxPolarAngle = Math.PI / 2;
  controls.enableZoom = false; // we drive zoom ourselves via mode.zoom
  controls.enablePan = false;  // two-finger drag should never pan the camera
  // rotateSpeed is set later, once COLS is known.

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
  const ROWS = 12;
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

  // Env map
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 1024; envCanvas.height = 512;
  const envCtx = envCanvas.getContext('2d')!;
  envCtx.fillStyle = '#050203'; envCtx.fillRect(0, 0, 1024, 512);
  for (let i = 0; i < 30; i++) {
    envCtx.fillStyle = ['#00ffff', '#ff00ff', '#ffffff', '#ffaa00'][Math.floor(Math.random() * 4)];
    envCtx.globalAlpha = 0.2 + Math.random() * 0.8;
    envCtx.fillRect(Math.random() * 1024, Math.random() * 512, 100 + Math.random() * 300, 5 + Math.random() * 20);
  }
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = envTex;

  // Hardware
  const goldMaterial = new THREE.MeshStandardMaterial({ color: 0xe5b45c, metalness: 1.0, roughness: 0.15 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 1.0, roughness: 0.1 });
  const tealMaterial = new THREE.MeshStandardMaterial({ color: 0x006666, metalness: 0.4, roughness: 0.4 });
  const drumMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.7, roughness: 0.3 });
  const aluminumMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.9, roughness: 0.4 });
  const whiteBracketMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 0.2, roughness: 0.6 });

  jukeboxGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, HEIGHT_TOTAL - 1, 64), drumMaterial));
  const rimGeo = new THREE.TorusGeometry(R + 0.2, 0.6, 16, 64);
  const topRim = new THREE.Mesh(rimGeo, goldMaterial); topRim.rotation.x = Math.PI / 2; topRim.position.y = HEIGHT_TOTAL / 2; jukeboxGroup.add(topRim);
  const botRim = new THREE.Mesh(rimGeo, goldMaterial); botRim.rotation.x = Math.PI / 2; botRim.position.y = -HEIGHT_TOTAL / 2; jukeboxGroup.add(botRim);
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
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, HEIGHT_TOTAL - 2, 0.4), tealMaterial); base.castShadow = true; bg.add(base);
      const pL = new THREE.Mesh(new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04), chromeMat); pL.position.set(-0.15, 0, 0.2); bg.add(pL);
      const pR = new THREE.Mesh(new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04), chromeMat); pR.position.set(0.15, 0, 0.2); bg.add(pR);
    } else {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, HEIGHT_TOTAL - 2, 0.15), aluminumMat); base.castShadow = true; bg.add(base);
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

  // --- Full spin7 card generator ---
  function xmur3(str: string) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0); };
  }
  const palettes = [
    ['#e63946', '#f1faee', '#1d3557', '#a8dadc'], ['#ffb703', '#fb8500', '#023047', '#8ecae6'],
    ['#ef476f', '#ffd166', '#06d6a0', '#073b4c'], ['#ffffff', '#000000', '#dddddd', '#ff0000'],
    ['#f4a261', '#e76f51', '#2a9d8f', '#264653'], ['#8ecae6', '#219ebc', '#023047', '#ffb703'],
    ['#d9ed92', '#b5e48c', '#34a0a4', '#1a759f'], ['#2b2d42', '#8d99ae', '#edf2f4', '#d90429'],
    ['#000000', '#14213d', '#fca311', '#e5e5e5'], ['#3d5a80', '#98c1d9', '#e0fbfc', '#ee6c4d'],
    ['#ff9f1c', '#ffbf69', '#ffffff', '#cbf3f0'], ['#f72585', '#7209b7', '#3a0ca3', '#4cc9f0'],
    ['#dad7cd', '#a3b18a', '#588157', '#344e41'], ['#fec5bb', '#fcd5ce', '#fae1dd', '#f8edeb'],
    ['#000000', '#d4af37', '#ffffff', '#111111'], ['#ff00ff', '#00ffff', '#000000', '#ffff00'],
    ['#f4e285', '#f4a259', '#5b8e7d', '#bc4b51'], ['#2a0800', '#f4d03f', '#e74c3c', '#ffffff'],
    ['#fdf6e3', '#eee8d5', '#073642', '#cb4b16'], ['#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
    ['#ff595e', '#ffca3a', '#8ac926', '#1982c4'], ['#1d3557', '#457b9d', '#a8dadc', '#e63946'],
    ['#283618', '#606c38', '#fefae0', '#dda15e'], ['#5f0f40', '#9a031e', '#fb8b24', '#e36414'],
    ['#0b132b', '#1c2541', '#3a506b', '#5bc0be'], ['#335c67', '#fff3b0', '#e09f3e', '#9e2a2b'],
    ['#003049', '#d62828', '#f77f00', '#fcbf49'], ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7'],
    ['#0d3b66', '#faf0ca', '#f4d35e', '#ee964b'], ['#f94144', '#f3722c', '#f8961e', '#f9c74f'],
    ['#5d5c61', '#379683', '#7395ae', '#557a95'], ['#1a1a1d', '#4e4e50', '#6f2232', '#950740'],
    ['#c0c0c0', '#ffffff', '#808080', '#000000'], ['#ffe066', '#247ba0', '#70c1b3', '#50514f'],
    ['#6b2d5c', '#f0386b', '#ff5376', '#f8c0c8'],
  ];
  const displayFonts = ["'Anton'", "'Bebas Neue'", "'Anton'", "'Righteous'", "'Fjalla One'", "'Limelight'", "'Rampart One'", "'Rubik Mono One'", "'Abril Fatface'", "'Bungee'", "'Bangers'"];
  const scriptFonts = ["'Pacifico'", "'Lobster'", "'Yellowtail'", "'Satisfy'", "'Shrikhand'", "'Permanent Marker'", "'Fascinate'"];
  const infoFonts = ["'Courier Prime'", "'Oswald'", "'Cinzel'", "'Playfair Display'", "'Poiret One'", 'Arimo'];

  function getContrast(hex: string) {
    if (!hex || hex[0] !== '#') return '#000000';
    const r = parseInt(hex.substr(1, 2), 16); const g = parseInt(hex.substr(3, 2), 16); const b = parseInt(hex.substr(5, 2), 16);
    return ((r * 299 + g * 587 + b * 114) / 1000 >= 128) ? '#000000' : '#ffffff';
  }

  function generateCardTexture(song: any) {
    const seedStr = song.titleA + song.artist + song.code;
    const seedGen = xmur3(seedStr);
    const rnd = () => (seedGen() >>> 0) / 4294967296;
    const rndInt = (max: number) => Math.floor(rnd() * max);

    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 100;
    const ctx = canvas.getContext('2d')!;

    const bgStyle = rndInt(30); const decorStyle = rndInt(30);
    const borderStyle = rndInt(9); const layoutStyle = rndInt(30);
    const fDisp = displayFonts[rndInt(displayFonts.length)];
    const fScrpt = scriptFonts[rndInt(scriptFonts.length)];
    const fInfo = infoFonts[rndInt(infoFonts.length)];

    const pal = palettes[rndInt(palettes.length)];
    const bg1 = pal[0]; const bg2 = pal[1]; const acc1 = pal[2]; const acc2 = pal[3];
    const tc1 = getContrast(bg1);

    const drawAdvText = (text: string, x: number, y: number, font: string, color: string, align: any, scaleX = 1, scaleY = 1, rot = 0, shadow = false) => {
      ctx.save(); if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3; ctx.shadowBlur = 0; }
      ctx.fillStyle = color; ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'middle';
      ctx.translate(x, y); ctx.rotate(rot); ctx.scale(scaleX, scaleY); ctx.fillText(text, 0, 0, 240 / scaleX); ctx.restore();
    };

    const drawIcon = (type: number, cx: number, cy: number, size: number, color: string) => {
      ctx.fillStyle = color; ctx.beginPath();
      if (type === 0) { for (let i = 0; i < 10; i++) { const r = (i % 2 === 0) ? size : size / 2; const a = (i / 10) * Math.PI * 2 - Math.PI / 2; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } }
      else if (type === 1) { ctx.arc(cx - size / 4, cy + size / 4, size / 4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.fillRect(cx, cy - size / 2, size / 6, size * 0.8); ctx.moveTo(cx, cy - size / 2); ctx.quadraticCurveTo(cx + size / 2, cy - size / 4, cx + size / 2, cy + size / 4); ctx.lineTo(cx + size / 3, cy + size / 4); ctx.quadraticCurveTo(cx + size / 3, cy - size / 4, cx, cy - size / 4); }
      else if (type === 2) { ctx.moveTo(cx + size / 4, cy - size / 2); ctx.lineTo(cx - size / 2, cy + size / 8); ctx.lineTo(cx - size / 8, cy + size / 8); ctx.lineTo(cx - size / 4, cy + size / 2); ctx.lineTo(cx + size / 2, cy - size / 8); ctx.lineTo(cx + size / 8, cy - size / 8); }
      else if (type === 3) { ctx.moveTo(cx, cy - size / 2); ctx.lineTo(cx + size / 2, cy); ctx.lineTo(cx, cy + size / 2); ctx.lineTo(cx - size / 2, cy); }
      else if (type === 4) { ctx.arc(cx, cy, size / 2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = getContrast(color); ctx.beginPath(); ctx.arc(cx, cy, size / 6, 0, Math.PI * 2); }
      else if (type === 5) { ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = color; ctx.lineWidth = 2; for (let i = 0; i < 3; i++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.ellipse(0, 0, size, size / 3, 0, 0, Math.PI * 2); ctx.stroke(); } ctx.fillStyle = getContrast(bg1); ctx.beginPath(); ctx.arc(0, 0, size / 5, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
      else if (type === 6) { ctx.moveTo(cx - size, cy + size / 2); ctx.lineTo(cx - size, cy - size / 2); ctx.lineTo(cx - size / 2, cy); ctx.lineTo(cx, cy - size); ctx.lineTo(cx + size / 2, cy); ctx.lineTo(cx + size, cy - size / 2); ctx.lineTo(cx + size, cy + size / 2); }
      else if (type === 7) { ctx.moveTo(cx - size, cy + size); ctx.quadraticCurveTo(cx, cy, cx + size, cy - size); ctx.quadraticCurveTo(cx + size / 2, cy + size / 2, cx - size, cy + size); }
      else if (type === 8) { ctx.moveTo(cx, cy - size / 2); ctx.bezierCurveTo(cx + size / 3, cy - size / 2, cx + size / 2, cy - size / 4, cx + size / 2, cy); ctx.lineTo(cx + size / 2.5, cy + size / 6); ctx.lineTo(cx + size / 2, cy + size / 3); ctx.lineTo(cx + size / 3, cy + size / 2); ctx.lineTo(cx - size / 2, cy + size / 2); ctx.lineTo(cx - size / 2, cy - size / 2); }
      else if (type === 9) { for (let i = 0; i < 16; i++) { const r = (i % 2 === 0) ? size : size * 0.7; const a = (i / 16) * Math.PI * 2; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } }
      ctx.fill();
    };

    // LAYER 1: BG
    ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 100); ctx.fillStyle = bg2;
    if (bgStyle === 1) { ctx.fillRect(0, 50, 256, 50); }
    else if (bgStyle === 2) { ctx.fillRect(128, 0, 128, 100); }
    else if (bgStyle === 3) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(256, 0); ctx.lineTo(256, 100); ctx.fill(); }
    else if (bgStyle === 4) { for (let i = 0; i < 100; i += 25) ctx.fillRect(0, i, 256, 12.5); }
    else if (bgStyle === 5) { for (let ix = 0; ix < 256; ix += 20) for (let iy = 0; iy < 100; iy += 20) if ((ix / 20 + iy / 20) % 2 === 0) ctx.fillRect(ix, iy, 20, 20); }
    else if (bgStyle === 6) { for (let ix = 15; ix < 256; ix += 30) for (let iy = 15; iy < 100; iy += 30) { ctx.beginPath(); ctx.arc(ix, iy, 6, 0, Math.PI * 2); ctx.fill(); } }
    else if (bgStyle === 7) { ctx.beginPath(); for (let i = 0; i < 24; i++) { ctx.moveTo(128, 50); ctx.lineTo(128 + Math.cos(i * Math.PI / 12) * 200, 50 + Math.sin(i * Math.PI / 12) * 200); ctx.lineTo(128 + Math.cos((i + 0.5) * Math.PI / 12) * 200, 50 + Math.sin((i + 0.5) * Math.PI / 12) * 200); } ctx.fill(); }
    else if (bgStyle === 8) { ctx.fillRect(0, 0, 85, 100); ctx.fillStyle = acc1; ctx.fillRect(171, 0, 85, 100); }
    else if (bgStyle === 9) { ctx.beginPath(); ctx.moveTo(0, 100); ctx.lineTo(0, 50); for (let i = 0; i <= 256; i += 10) ctx.lineTo(i, 50 + Math.sin(i / 20) * 15); ctx.lineTo(256, 100); ctx.fill(); }
    else if (bgStyle === 10) { ctx.beginPath(); for (let i = 0; i < 36; i++) { ctx.moveTo(128, 50); ctx.lineTo(128 + Math.cos(i * Math.PI / 18) * 200, 50 + Math.sin(i * Math.PI / 18) * 200); ctx.lineTo(128 + Math.cos((i + 0.5) * Math.PI / 18) * 200, 50 + Math.sin((i + 0.5) * Math.PI / 18) * 200); } ctx.fill(); }
    else if (bgStyle === 11) { ctx.lineWidth = 10; ctx.strokeStyle = bg2; for (let i = 10; i < 200; i += 25) { ctx.beginPath(); ctx.moveTo(128, 50 - i); ctx.lineTo(128 + i, 50); ctx.lineTo(128, 50 + i); ctx.lineTo(128 - i, 50); ctx.closePath(); ctx.stroke(); } }
    else if (bgStyle === 12) { ctx.fillStyle = bg2; ctx.fillRect(0, 20, 256, 20); ctx.fillStyle = acc1; ctx.fillRect(0, 60, 256, 20); }
    else if (bgStyle === 13) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(128, 0); ctx.lineTo(0, 100); ctx.fill(); ctx.fillStyle = acc1; ctx.beginPath(); ctx.moveTo(256, 100); ctx.lineTo(128, 100); ctx.lineTo(256, 0); ctx.fill(); }
    else if (bgStyle === 14) { for (let ix = 10; ix < 256; ix += 15) for (let iy = 10; iy < 100; iy += 15) { ctx.beginPath(); ctx.arc(ix, iy, (ix / 256) * 6, 0, Math.PI * 2); ctx.fill(); } }
    else if (bgStyle === 15) { ctx.fillStyle = bg2; ctx.fillRect(0, 30, 256, 40); }
    else if (bgStyle === 16) { ctx.fillStyle = acc1; ctx.fillRect(0, 0, 60, 100); ctx.fillStyle = bg2; ctx.fillRect(60, 0, 196, 100); }
    else if (bgStyle === 17) { ctx.beginPath(); ctx.moveTo(0, 50); ctx.quadraticCurveTo(128, 0, 256, 50); ctx.lineTo(256, 100); ctx.lineTo(0, 100); ctx.fill(); }
    else if (bgStyle === 18) { ctx.fillStyle = bg2; ctx.fillRect(0, 0, 256, 20); ctx.fillRect(0, 80, 256, 20); }
    else if (bgStyle === 19) { ctx.fillStyle = bg2; for (let i = 0; i < 100; i += 10) ctx.fillRect(0, i, 30, 5); }
    else if (bgStyle === 20) { ctx.fillStyle = bg2; ctx.fillRect(0, 0, 40, 100); ctx.fillStyle = acc1; for (let i = 5; i < 100; i += 15) ctx.fillRect(5, i, 30, 5); }
    else if (bgStyle === 21) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 50); ctx.fillStyle = bg2; ctx.fillRect(0, 50, 256, 50); }
    else if (bgStyle === 22) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 33); ctx.fillStyle = bg2; ctx.fillRect(0, 33, 256, 34); ctx.fillStyle = acc1; ctx.fillRect(0, 67, 256, 33); }
    else if (bgStyle === 23) { ctx.fillStyle = bg2; ctx.beginPath(); ctx.ellipse(128, 50, 140, 60, 0, 0, Math.PI * 2); ctx.fill(); }
    else if (bgStyle === 24) { ctx.fillStyle = bg2; for (let ix = 0; ix <= 256; ix += 40) for (let iy = 0; iy <= 100; iy += 40) { ctx.beginPath(); ctx.moveTo(ix, iy - 20); ctx.lineTo(ix + 20, iy); ctx.lineTo(ix, iy + 20); ctx.lineTo(ix - 20, iy); ctx.fill(); } }
    else if (bgStyle === 25) { ctx.fillStyle = bg2; ctx.fillRect(0, 0, 50, 100); ctx.fillStyle = bg1; ctx.fillRect(50, 0, 206, 100); }
    else if (bgStyle === 26) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 100); ctx.fillStyle = bg2; ctx.beginPath(); for (let i = -100; i < 350; i += 30) { ctx.moveTo(i, 0); ctx.lineTo(i + 15, 0); ctx.lineTo(i - 85, 100); ctx.lineTo(i - 100, 100); } ctx.fill(); }
    else if (bgStyle === 27) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 100); ctx.fillStyle = acc1; ctx.fillRect(0, 0, 256, 25); ctx.fillRect(0, 75, 256, 25); }
    else if (bgStyle === 28) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 100); ctx.fillStyle = bg2; ctx.beginPath(); ctx.arc(40, 50, 45, 0, Math.PI * 2); ctx.fill(); }
    else if (bgStyle === 29) { ctx.fillStyle = bg1; ctx.fillRect(0, 0, 256, 30); ctx.fillStyle = acc2; ctx.fillRect(0, 30, 256, 70); }

    // LAYER 2: DECOR
    if (decorStyle === 1) { ctx.globalAlpha = 0.2; drawIcon(0, 128, 50, 80, acc1); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 2) { ctx.globalAlpha = 0.15; drawAdvText(song.code, 128, 50, 'bold 90px Arimo', tc1, 'center'); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 3) { drawIcon(4, 128, 50, 90, bg2 === bg1 ? acc1 : bg2); }
    else if (decorStyle === 4) { ctx.globalAlpha = 0.15; drawAdvText(song.artist.toUpperCase(), 128, 50, '60px ' + fDisp, tc1, 'center'); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 5) { ctx.globalAlpha = 0.4; for (let i = 0; i < 5; i++) drawIcon(1, 20 + rndInt(216), 20 + rndInt(60), 15 + rndInt(15), acc2); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 6) { drawIcon(3, 64, 50, 40, acc1); drawIcon(3, 192, 50, 40, acc2); }
    else if (decorStyle === 7) { ctx.globalAlpha = 0.3; drawIcon(2, 128, 50, 80, acc1); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 8) { ctx.strokeStyle = acc2; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(128, 50, 40, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(128, 50, 30, 0, Math.PI * 2); ctx.stroke(); }
    else if (decorStyle === 9) { ctx.fillStyle = acc1; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40, 0); ctx.lineTo(0, 40); ctx.fill(); ctx.beginPath(); ctx.moveTo(256, 100); ctx.lineTo(216, 100); ctx.lineTo(256, 60); ctx.fill(); }
    else if (decorStyle === 10) { drawIcon(5, 128, 50, 60, acc2); }
    else if (decorStyle === 11) { ctx.globalAlpha = 0.5; drawIcon(7, 60, 50, 30, acc1); drawIcon(7, 190, 30, 40, bg2); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 12) { drawIcon(6, 128, 50, 60, acc1); }
    else if (decorStyle === 13) { ctx.fillStyle = acc2; ctx.globalAlpha = 0.4; ctx.fillRect(20, 20, 40, 40); ctx.beginPath(); ctx.arc(200, 70, 25, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 14) { ctx.strokeStyle = acc1; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 50); for (let i = 0; i < 256; i += 20) ctx.lineTo(i, (i % 40 === 0) ? 20 : 80); ctx.stroke(); }
    else if (decorStyle === 15) { drawIcon(1, 30, 50, 40, acc1); drawIcon(1, 45, 60, 20, acc2); }
    else if (decorStyle === 16) { ctx.globalAlpha = 0.15; drawAdvText(song.titleA.charAt(0), 128, 50, 'bold 120px ' + fDisp, tc1, 'center'); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 17) { ctx.fillStyle = acc2; ctx.fillRect(10, 48, 236, 4); }
    else if (decorStyle === 18) { drawIcon(5, 40, 50, 45, acc1); ctx.fillRect(80, 49, 150, 2); }
    else if (decorStyle === 19) { for (let ix = 5; ix < 40; ix += 8) for (let iy = 5; iy < 95; iy += 8) { ctx.fillStyle = ((ix + iy) % 16 === 0) ? acc1 : acc2; ctx.beginPath(); ctx.arc(ix, iy, 3, 0, Math.PI * 2); ctx.fill(); } }
    else if (decorStyle === 20) { ctx.fillStyle = acc1; ctx.fillRect(0, 0, 70, 100); drawIcon(8, 35, 50, 30, acc2); }
    else if (decorStyle === 21) { ctx.fillStyle = bg2; ctx.beginPath(); ctx.moveTo(40, 30); ctx.lineTo(216, 30); ctx.arc(216, 50, 20, -Math.PI / 2, Math.PI / 2); ctx.lineTo(40, 70); ctx.arc(40, 50, 20, Math.PI / 2, -Math.PI / 2); ctx.fill(); }
    else if (decorStyle === 22) { ctx.fillStyle = acc2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(30, 0); ctx.lineTo(0, 30); ctx.fill(); ctx.beginPath(); ctx.moveTo(256, 0); ctx.lineTo(226, 0); ctx.lineTo(256, 30); ctx.fill(); ctx.beginPath(); ctx.moveTo(0, 100); ctx.lineTo(30, 100); ctx.lineTo(0, 70); ctx.fill(); ctx.beginPath(); ctx.moveTo(256, 100); ctx.lineTo(226, 100); ctx.lineTo(256, 70); ctx.fill(); }
    else if (decorStyle === 23) { ctx.globalAlpha = 0.6; drawIcon(9, 210, 50, 35, acc1); ctx.globalAlpha = 1.0; }
    else if (decorStyle === 24) { ctx.fillStyle = acc1; ctx.fillRect(0, 25, 256, 4); ctx.fillRect(0, 71, 256, 4); }
    else if (decorStyle === 25) { ctx.fillStyle = acc1; for (let y = 10; y < 100; y += 10) { ctx.beginPath(); ctx.arc(60, y, 2, 0, Math.PI * 2); ctx.fill(); } }
    else if (decorStyle === 26) { ctx.fillStyle = acc2; ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI / 2); ctx.lineTo(0, 0); ctx.fill(); ctx.beginPath(); ctx.arc(256, 0, 20, Math.PI / 2, Math.PI); ctx.lineTo(256, 0); ctx.fill(); ctx.beginPath(); ctx.arc(0, 100, 20, -Math.PI / 2, 0); ctx.lineTo(0, 100); ctx.fill(); ctx.beginPath(); ctx.arc(256, 100, 20, Math.PI, Math.PI * 1.5); ctx.lineTo(256, 100); ctx.fill(); }
    else if (decorStyle === 27) { ctx.fillStyle = acc1; for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) { if ((r + c) % 2 === 0) ctx.fillRect(10 + c * 10, 35 + r * 10, 10, 10); } } }
    else if (decorStyle === 28) { ctx.fillStyle = acc2; ctx.beginPath(); ctx.moveTo(200, 20); ctx.lineTo(230, 50); ctx.lineTo(200, 80); ctx.fill(); }
    else if (decorStyle === 29) { ctx.fillStyle = acc1; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(80, 50); ctx.lineTo(0, 100); ctx.fill(); }

    // LAYER 3: BORDERS
    let cBg = bg1;
    if (borderStyle === 1) { ctx.strokeStyle = acc1; ctx.lineWidth = 4; ctx.strokeRect(4, 4, 248, 92); }
    else if (borderStyle === 2) { ctx.strokeStyle = acc1; ctx.lineWidth = 3; ctx.strokeRect(3, 3, 250, 94); ctx.strokeStyle = tc1; ctx.lineWidth = 1; ctx.strokeRect(8, 8, 240, 84); }
    else if (borderStyle === 3) { ctx.strokeStyle = acc2; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.strokeRect(6, 6, 244, 88); ctx.setLineDash([]); }
    else if (borderStyle === 4) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(15, 15, 226, 70); cBg = '#ffffff'; }
    else if (borderStyle === 5) { ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(15, 15, 226, 70); cBg = '#000000'; }
    else if (borderStyle === 6) { ctx.fillStyle = acc1; ctx.fillRect(0, 0, 256, 15); ctx.fillRect(0, 85, 256, 15); }
    else if (borderStyle === 7) { ctx.fillStyle = acc2; ctx.fillRect(0, 0, 15, 100); ctx.fillRect(241, 0, 15, 100); }
    else if (borderStyle === 8) { ctx.strokeStyle = tc1; ctx.lineWidth = 2; ctx.strokeRect(10, 10, 236, 80); ctx.strokeStyle = acc1; ctx.strokeRect(12, 12, 236, 80); }

    const mTxt = getContrast(cBg); const aTxt = (mTxt === '#ffffff') ? acc1 : acc2;

    // LAYER 4: TYPO
    const tA = song.titleA.toUpperCase(); const tB = song.titleB.toUpperCase(); const art = song.artist; const cd = song.code;
    const boxCode = (bx: number, by: number, bw: number, bh: number) => { ctx.fillStyle = aTxt; ctx.fillRect(bx, by, bw, bh); drawAdvText(cd, bx + bw / 2, by + bh / 2, 'bold 14px Arimo', getContrast(aTxt), 'center'); };

    if (layoutStyle === 0) { boxCode(5, 5, 30, 25); drawAdvText(tA, 128, 30, '22px ' + fDisp, mTxt, 'center'); drawAdvText('by ' + art, 128, 55, '18px ' + fScrpt, aTxt, 'center'); drawAdvText(tB, 128, 80, '22px ' + fDisp, mTxt, 'center'); }
    else if (layoutStyle === 1) { drawAdvText(tA, 64, 40, '20px ' + fDisp, getContrast(bg1), 'center', 1, 1.2); drawAdvText(tB, 192, 40, '20px ' + fDisp, getContrast((bgStyle === 1 || bgStyle === 2) ? bg2 : bg1), 'center', 1, 1.2); ctx.fillStyle = mTxt; ctx.fillRect(0, 75, 256, 25); drawAdvText(art + '  [' + cd + ']', 128, 87, '14px ' + fInfo, getContrast(mTxt), 'center'); }
    else if (layoutStyle === 2) { drawAdvText(art, 128, 40, '36px ' + fScrpt, mTxt, 'center', 1, 1.2, -0.05); drawAdvText(tA + ' / ' + tB, 128, 80, '16px ' + fInfo, aTxt, 'center'); boxCode(220, 5, 30, 30); }
    else if (layoutStyle === 3) { drawAdvText(tA, 128, 45, '32px ' + fDisp, mTxt, 'center', 1, 1.5); drawAdvText(art + ' • ' + tB, 128, 85, '12px ' + fInfo, aTxt, 'center'); drawAdvText(cd, 20, 20, 'bold 16px ' + fInfo, mTxt, 'center'); }
    else if (layoutStyle === 4) { drawAdvText(tA, 64, 30, '20px ' + fDisp, getContrast(bg1), 'center'); drawAdvText(cd, 192, 30, '30px ' + fDisp, getContrast((bgStyle === 2 || bgStyle === 8) ? bg2 : bg1), 'center'); drawAdvText(art, 64, 75, '16px ' + fScrpt, getContrast(bg1), 'center'); drawAdvText(tB, 192, 75, '20px ' + fDisp, getContrast((bgStyle === 2 || bgStyle === 8) ? bg2 : bg1), 'center'); }
    else if (layoutStyle === 5) { ctx.save(); ctx.translate(128, 50); ctx.rotate(-0.08); drawAdvText(tA, 0, -20, '24px ' + fDisp, mTxt, 'center'); drawAdvText(art, 0, 5, '18px ' + fScrpt, aTxt, 'center'); drawAdvText(tB, 0, 30, '16px ' + fInfo, mTxt, 'center'); ctx.restore(); boxCode(5, 65, 35, 30); }
    else if (layoutStyle === 6) { ctx.fillStyle = aTxt; ctx.fillRect(0, 0, 60, 100); drawAdvText(cd, 30, 25, 'bold 24px ' + fInfo, getContrast(aTxt), 'center'); drawAdvText(art, -50, 30, '14px ' + fInfo, getContrast(aTxt), 'center', 1, 1, -Math.PI / 2); drawAdvText(tA, 158, 35, '22px ' + fDisp, mTxt, 'center'); drawAdvText(tB, 158, 65, '22px ' + fDisp, mTxt, 'center'); }
    else if (layoutStyle === 7) { drawIcon(0, 30, 50, 15, aTxt); drawIcon(0, 226, 50, 15, aTxt); drawAdvText(tA, 128, 25, '20px ' + fDisp, mTxt, 'center', 1, 1.2); drawAdvText('STAR: ' + art, 128, 50, '12px ' + fInfo, aTxt, 'center'); drawAdvText(tB, 128, 75, '20px ' + fDisp, mTxt, 'center', 1, 1.2); }
    else if (layoutStyle === 8) { drawAdvText(tA, 128, 30, '26px ' + fScrpt, mTxt, 'center'); drawAdvText('by ' + art, 128, 65, '20px ' + fScrpt, aTxt, 'center'); drawAdvText(cd, 20, 80, '16px ' + fInfo, mTxt, 'center'); }
    else if (layoutStyle === 9) { drawAdvText(tA, 128, 25, '24px ' + fDisp, mTxt, 'center', 1.5, 0.8); drawAdvText(art, 128, 55, '18px ' + fInfo, aTxt, 'center', 1.2, 0.8); drawAdvText(tB, 128, 80, '24px ' + fDisp, mTxt, 'center', 1.5, 0.8); boxCode(0, 0, 30, 20); }
    else if (layoutStyle === 10) { drawAdvText(tA, 128, 30, '26px ' + fDisp, mTxt, 'center', 1, 1, 0, true); drawAdvText(art, 128, 70, '18px ' + fScrpt, aTxt, 'center', 1, 1, 0, true); drawAdvText(cd, 230, 20, '14px ' + fInfo, mTxt, 'center'); }
    else if (layoutStyle === 11) { ctx.fillStyle = mTxt; ctx.fillRect(20, 20, 216, 25); ctx.fillRect(50, 55, 156, 25); drawAdvText(tA, 128, 32, '18px ' + fDisp, getContrast(mTxt), 'center'); drawAdvText(art, 128, 67, '16px ' + fInfo, getContrast(mTxt), 'center'); }
    else if (layoutStyle === 12) { ctx.fillStyle = aTxt; ctx.beginPath(); ctx.arc(128, 50, 25, 0, Math.PI * 2); ctx.fill(); drawAdvText(cd, 128, 50, 'bold 18px ' + fInfo, getContrast(aTxt), 'center'); drawAdvText(tA, 55, 50, '20px ' + fDisp, mTxt, 'center'); drawAdvText(tB, 201, 50, '20px ' + fDisp, mTxt, 'center'); }
    else if (layoutStyle === 13) { ctx.fillStyle = aTxt; ctx.beginPath(); ctx.moveTo(200, 0); ctx.lineTo(256, 0); ctx.lineTo(256, 56); ctx.fill(); ctx.save(); ctx.translate(235, 20); ctx.rotate(Math.PI / 4); drawAdvText(cd, 0, 0, 'bold 12px Arimo', getContrast(aTxt), 'center'); ctx.restore(); drawAdvText(tA, 110, 40, '24px ' + fScrpt, mTxt, 'center'); drawAdvText(art, 110, 70, '14px ' + fInfo, mTxt, 'center'); }
    else if (layoutStyle === 14) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 128, 100); ctx.fillStyle = '#eee'; ctx.fillRect(128, 0, 128, 100); drawAdvText(tA, 64, 40, '20px ' + fDisp, '#eee', 'center'); drawAdvText(tB, 192, 40, '20px ' + fDisp, '#111', 'center'); ctx.fillStyle = acc1; ctx.fillRect(80, 75, 96, 25); drawAdvText(art, 128, 87, '14px ' + fInfo, getContrast(acc1), 'center'); drawAdvText(cd, 15, 15, 'bold 12px Arimo', '#eee', 'left'); }
    else if (layoutStyle === 15) { drawAdvText(tA, 128, 40, '40px ' + fDisp, mTxt, 'center', 1, 1.4); drawAdvText(art + ' • ' + cd, 240, 85, '12px ' + fInfo, aTxt, 'right'); }
    else if (layoutStyle === 16) { ctx.fillStyle = aTxt; ctx.fillRect(0, 0, 60, 100); drawAdvText(cd, 30, 50, 'bold 20px ' + fInfo, getContrast(aTxt), 'center'); drawAdvText(tA, 70, 30, '22px ' + fDisp, mTxt, 'left'); drawAdvText(art, 70, 60, '16px ' + fScrpt, aTxt, 'left'); drawAdvText(tB, 70, 85, '14px ' + fDisp, mTxt, 'left'); }
    else if (layoutStyle === 17) { drawAdvText(tA, 130, 42, '28px ' + fDisp, '#000000', 'center', 1, 1); drawAdvText(tA, 128, 40, '28px ' + fDisp, mTxt, 'center', 1, 1); drawAdvText('BY ' + art, 128, 75, '16px ' + fInfo, aTxt, 'center'); boxCode(10, 10, 35, 20); }
    else if (layoutStyle === 18) { drawAdvText(art, 128, 20, '14px ' + fInfo, aTxt, 'center'); ctx.fillStyle = mTxt; ctx.fillRect(20, 35, 216, 35); drawAdvText(tA, 128, 53, '24px ' + fDisp, getContrast(mTxt), 'center'); drawAdvText(tB, 128, 85, '14px ' + fScrpt, mTxt, 'center'); }
    else if (layoutStyle === 19) { drawAdvText(tA.charAt(0), 40, 50, '60px ' + fDisp, aTxt, 'center'); drawAdvText(tA.slice(1), 75, 40, '24px ' + fDisp, mTxt, 'left'); drawAdvText(art, 75, 70, '18px ' + fScrpt, mTxt, 'left'); drawAdvText(cd, 240, 20, '12px Arimo', aTxt, 'right'); }
    else if (layoutStyle === 20) { boxCode(10, 10, 35, 20); drawAdvText(tA, 240, 40, '24px ' + fDisp, mTxt, 'right', 1, 1.2); drawAdvText(art, 240, 75, '16px ' + fScrpt, aTxt, 'right'); }
    else if (layoutStyle === 21) { drawAdvText(tA.split(' ')[0], 40, 35, '26px ' + fDisp, mTxt, 'left'); drawAdvText(tA.split(' ').slice(1).join(' ') || 'HIT', 216, 65, '26px ' + fDisp, mTxt, 'right'); drawAdvText(cd + ' • ' + art, 128, 50, '12px ' + fInfo, aTxt, 'center'); }
    else if (layoutStyle === 22) { drawAdvText(art + ' [' + cd + ']', 128, 25, '14px ' + fInfo, aTxt, 'center'); drawAdvText(tA, 128, 65, '36px ' + fDisp, mTxt, 'center', 1, 1.5); }
    else if (layoutStyle === 23) { ctx.strokeStyle = mTxt; ctx.lineWidth = 1.5; ctx.font = '30px ' + fDisp; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.strokeText(tA, 128, 40, 240); drawAdvText(art, 128, 75, '16px ' + fScrpt, aTxt, 'center'); drawAdvText(cd, 20, 20, '12px Arimo', mTxt, 'center'); }
    else if (layoutStyle === 24) { drawAdvText(tA, 128, 35, '28px ' + fDisp, mTxt, 'center', 1.2, 1); ctx.fillStyle = aTxt; ctx.fillRect(64, 65, 128, 20); drawAdvText(art, 128, 75, '14px ' + fInfo, getContrast(aTxt), 'center'); boxCode(210, 70, 35, 20); }
    else if (layoutStyle === 25) { drawAdvText(art, 128, 20, '14px ' + fInfo, aTxt, 'center'); drawAdvText(tA, 128, 60, '40px ' + fDisp, mTxt, 'center', 1, 1.2); drawAdvText(cd, 25, 85, '12px Arimo', mTxt, 'left'); }
    else if (layoutStyle === 26) { drawAdvText(cd, 25, 50, 'bold 16px ' + fInfo, getContrast(bgStyle === 25 ? bg2 : bg1), 'center', 1, 1, -Math.PI / 2); drawAdvText(tA, 150, 35, '26px ' + fDisp, mTxt, 'center'); drawAdvText(art, 150, 70, '16px ' + fScrpt, aTxt, 'center'); }
    else if (layoutStyle === 27) { drawAdvText(tA, 128, 25, '18px ' + fDisp, mTxt, 'center'); drawAdvText(tB, 128, 50, '18px ' + fDisp, mTxt, 'center'); drawAdvText(art, 128, 75, '18px ' + fScrpt, aTxt, 'center'); }
    else if (layoutStyle === 28) { drawAdvText(art, 128, 25, '16px ' + fScrpt, aTxt, 'center'); drawAdvText(tA, 128, 70, '36px ' + fDisp, mTxt, 'center', 1.2, 1); }
    else if (layoutStyle === 29) { ctx.fillStyle = aTxt; ctx.beginPath(); ctx.moveTo(40, 40); ctx.lineTo(216, 40); ctx.arc(216, 50, 10, -Math.PI / 2, Math.PI / 2); ctx.lineTo(40, 60); ctx.arc(40, 50, 10, Math.PI / 2, -Math.PI / 2); ctx.fill(); drawAdvText(tA, 128, 50, '18px ' + fDisp, getContrast(aTxt), 'center'); drawAdvText(art, 128, 80, '14px ' + fInfo, mTxt, 'center'); drawAdvText(cd, 128, 20, '14px Arimo', mTxt, 'center'); }

    // Source stripe (Spotify integration only — not in spin7)
    const srcColor = song.source === 'now' ? '#00ff88' : song.source === 'queue' ? '#ffaa00' : null;
    if (srcColor) { ctx.fillStyle = srcColor; ctx.fillRect(0, 0, 4, 100); }

    // Paper noise overlay
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = (i % 2 === 0) ? '#000000' : '#ffffff';
      ctx.globalAlpha = rnd() * 0.04;
      ctx.fillRect(rndInt(256), rndInt(100), 1.5, 1.5);
    }
    ctx.globalAlpha = 1.0;

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearFilter;
    return { texture, accent: acc1, bg: bg1, alt: acc2 };
  }

  const cards: any[] = [];
  let activeCard: any = null;
  const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const categories = ['extended play', 'varieties', 'your picks', 'favorites', 'soul', 'popular', 'hit tunes', 'jazz', 'country', 'rock & roll'];

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
    cctx.fillStyle = '#ffffff'; cctx.font = "bold 28px 'Oswald', sans-serif";
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
    jukeboxGroup.add(catMesh);

    for (let r = 0; r < ROWS; r++) {
      const idx = c * ROWS + r;
      if (idx >= displayTracks.length) break;
      const t = displayTracks[idx];
      if (!t) { emptySlots.push({ c, r }); continue; }
      const card = buildCard(t, c, r);
      jukeboxGroup.add(card);
      cards.push(card);
    }
  }

  // Add a new now-playing track. Uses an empty slot if available, otherwise
  // recycles the oldest previously-queued slot. Returns the (existing or new)
  // card for the given URI, or null if none can be placed.
  function placeIncoming(raw: any): any {
    const existing = cards.find((c) => c.userData.song.uri === raw.uri);
    if (existing) return existing;
    let slot: { c: number; r: number } | undefined;
    if (emptySlots.length > 0) {
      slot = emptySlots.shift();
    } else if (queueCards.length > 0) {
      const oldest = queueCards.shift();
      slot = { c: oldest.userData.c, r: oldest.userData.r };
      jukeboxGroup.remove(oldest);
      cards.splice(cards.indexOf(oldest), 1);
      try { (oldest.material as any).map?.dispose?.(); (oldest.material as any).dispose?.(); } catch {}
    }
    if (!slot) return null;
    const card = buildCard(raw, slot.c, slot.r);
    jukeboxGroup.add(card);
    cards.push(card);
    queueCards.push(card);
    return card;
  }

  setBanner('Select a Track', true); // overridden below if a track is playing

  // --- In-scene chrome buttons parented to the camera (HUD-style) ---
  // Camera-attached objects render only if the camera itself is in the scene
  // graph. Add it explicitly, then attach the button row to it. The buttons
  // ride along with every camera movement → fixed screen position, like an
  // absolutely positioned div. They still receive real scene lighting and
  // reflect the env map because they're regular Three.js meshes.
  scene.add(camera);

  type Btn = { group: any; setLabel: (s: string) => void; visible: (v: boolean) => void };
  const buttonMeshes: any[] = [];

  function makeChromeButton(initialLabel: string, action: () => void): Btn {
    const W = 7.5, H = 1.6, D = 0.25;
    const g = new THREE.Group();

    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0xeeeeee, metalness: 1.0, roughness: 0.15,
      depthTest: false, depthWrite: false,
    });
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), bezelMat);
    bezel.renderOrder = 1000;
    bezel.userData.button = true;
    g.add(bezel);

    const faceMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, map: null as any,
      depthTest: false, depthWrite: false,
    });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.25, H - 0.25), faceMat);
    face.position.z = D / 2 + 0.001;
    face.renderOrder = 1001;
    face.userData.button = true;
    g.add(face);
    buttonMeshes.push(bezel, face);

    const setLabel = (text: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 768; canvas.height = 160;
      const ctx = canvas.getContext('2d')!;
      // Cream enamel placard (diner sign look)
      const grad = ctx.createLinearGradient(0, 0, 0, 160);
      grad.addColorStop(0, '#fff8e7');
      grad.addColorStop(0.5, '#f3e6c4');
      grad.addColorStop(1, '#e6d3a0');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 768, 160);
      // Diner-red double border
      ctx.strokeStyle = '#8b1a1a';
      ctx.lineWidth = 6; ctx.strokeRect(12, 12, 744, 136);
      ctx.lineWidth = 2; ctx.strokeRect(24, 24, 720, 112);
      // 50s placard typography
      ctx.font = "78px 'Limelight', 'Fascinate', 'Rampart One', 'Bebas Neue', sans-serif";
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Emboss
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(text, 386, 84, 700);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(text, 384, 78, 700);
      ctx.fillStyle = '#8b1a1a';
      ctx.fillText(text, 385, 81, 700);
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      faceMat.map = tex;
      faceMat.needsUpdate = true;
    };
    setLabel(initialLabel);

    g.userData.action = action;
    return {
      group: g,
      setLabel,
      visible: (v: boolean) => { g.visible = v; },
    };
  }

  // Buttons snap the continuous values to their extremes; the per-frame lerp
  // produces the spring/bounce feel as the scene catches up.
  const btnLighting = makeChromeButton(mode.lighting > 0.5 ? 'DINER' : 'RINK', () => {
    mode.lighting = mode.lighting > 0.5 ? 0 : 1;
    btnLighting.setLabel(mode.lighting > 0.5 ? 'DINER' : 'RINK');
  });
  const btnFit = makeChromeButton(mode.zoom > 0.5 ? 'FIT' : 'ZOOM', () => {
    mode.zoom = mode.zoom > 0.5 ? 0 : 1;
    btnFit.setLabel(mode.zoom > 0.5 ? 'FIT' : 'ZOOM');
  });
  const btnJump = makeChromeButton('PLAYING', () => {
    mode.goToActiveCard?.();
  });

  const buttonRow = new THREE.Group();
  const spacing = 8.5;
  btnLighting.group.position.x = -spacing;
  btnFit.group.position.x = 0;
  btnJump.group.position.x = spacing;
  buttonRow.add(btnLighting.group, btnFit.group, btnJump.group);
  // Top HUD buttons hidden for now — interactions are wheel/drag/double-tap.
  // camera.add(buttonRow);
  buttonRow.visible = false;
  const BUTTON_BASE_FOV = 45;
  const BUTTON_LOCAL_Z = -40;
  // Computed each frame in animate() based on current FOV

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
  // for the given Spotify item, sets it as active, positions the edge LEDs,
  // updates the banner, and jumps the drum so it's front-and-center.
  function syncNowPlaying(item: any) {
    if (!item?.uri) return;
    let match = cards.find((c) => c.userData.song.uri === item.uri);
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
    setBanner(`♫ ${item.name} — ${(item.artists || []).map((a: any) => a.name).join(', ')} ♫`, false);
    mode.goToActiveCard?.();
  }

  async function selectCard(card: any) {
    if (activeCard === card) {
      activeCard = null;
      setBanner('Select a Track', true);
      return;
    }
    playSelectionSound();
    activeCard = card;
    setBanner(`♫ ${card.userData.song.name} — ${card.userData.song.artist} ♫`, false);
    try { await play(card.userData.song.uri); } catch {}
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
  function getXY(event: any) {
    const e = event.touches ? event.touches[0] : event;
    return { x: e.clientX, y: e.clientY };
  }
  function onPointerDown(event: any) {
    initAudio();
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
    const { x, y } = getXY(event.changedTouches ? { touches: event.changedTouches } : event);
    const dx = x - downX, dy = y - downY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) return;
    if (Date.now() - downAt > 500) return;
    mouse.x = (x / window.innerWidth) * 2 - 1;
    mouse.y = -(y / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const btnHits = raycaster.intersectObjects(buttonMeshes, true);
    if (btnHits.length) {
      let m: any = btnHits[0].object;
      while (m && !m.userData?.action) m = m.parent;
      m?.userData?.action?.();
      lastTapAt = 0; // don't let a button-tap chain into a double-tap
      return;
    }
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

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  // Poll now-playing. syncNowPlaying handles deck lookup, queue placement,
  // LED positioning, and the jump-to-card camera move.
  const pollInterval = setInterval(async () => {
    try {
      const d = await nowPlaying();
      if (d?.item) syncNowPlaying(d.item);
    } catch {}
  }, 5000);

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
  function animate() {
    raf = requestAnimationFrame(animate);
    if (!isSceneReady) {
      isSceneReady = true;
      onSceneReady();
    }

    // Polar angle clamp transition (lock to horizontal scroll when zoomed in)
    // Lock vertical pan: horizontal-only rotation in both zoom modes
    const targetMinPolar = Math.PI / 2;
    const targetMaxPolar = Math.PI / 2;
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

    // Demo mode: orbit the CAMERA around the jukebox (same as the user dragging
    // left/right) so direction-tracking lights (dirLight, fillFrontAmber) also
    // rotate and the scene feels alive. Spinning jukeboxGroup alone leaves the
    // lights static.
    if (mode.demoSpin) {
      const az = controls.getAzimuthalAngle() + mode.demoSpin;
      const r = Math.hypot(camera.position.x, camera.position.z);
      camera.position.x = Math.sin(az) * r;
      camera.position.z = Math.cos(az) * r;
    }

    controls.update();

    // Keep HUD buttons at constant screen size as FOV changes. Aspect-aware
    // vertical placement near the top of the viewport.
    {
      const halfFov = (camera.fov * Math.PI) / 360;
      const halfBase = (BUTTON_BASE_FOV * Math.PI) / 360;
      const scale = Math.tan(halfFov) / Math.tan(halfBase);
      const visibleHalfH = Math.abs(BUTTON_LOCAL_Z) * Math.tan(halfFov);
      buttonRow.position.set(0, visibleHalfH - 1.8 * scale, BUTTON_LOCAL_Z);
      buttonRow.scale.setScalar(scale);
    }

    // Hide JUMP TO PLAYING when nothing is active
    btnJump.visible(!!activeCard);
    // Sync toggle labels to current continuous values
    {
      const wantLight = mode.lighting > 0.5 ? 'DINER' : 'RINK';
      if (btnLighting._label !== wantLight) { btnLighting.setLabel(wantLight); btnLighting._label = wantLight; }
      const wantZoom = mode.zoom > 0.5 ? 'FIT' : 'ZOOM';
      if (btnFit._label !== wantZoom) { btnFit.setLabel(wantZoom); btnFit._label = wantZoom; }
    }

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
      camera.position.lerp(new THREE.Vector3(tx, 0, tz), 0.12);
      controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.12);
    }

    // Offset the camera headlight to the right of the camera (relative to its
    // view direction), then aim it at the focal point. This grazes the cards
    // from the side instead of blowing out the center.
    const camToTarget = new THREE.Vector3().subVectors(controls.target, camera.position);
    const right = new THREE.Vector3().crossVectors(camToTarget, camera.up).normalize();
    const offsetDist = camToTarget.length() * 0.6;
    cameraLight.position.copy(camera.position).addScaledVector(right, offsetDist);
    cameraLight.target.position.copy(controls.target);

    const t = clock.getElapsedTime();
    const tColor1 = new THREE.Color();
    const tColor2 = new THREE.Color();

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
    const dColor1 = new THREE.Color(0xffeedd);
    const dColor2 = new THREE.Color(0xaaeeff);

    // Rink endpoint — moody, optionally driven by the active card's palette
    let rHemi: number, rDir: number;
    const rColor1 = new THREE.Color();
    const rColor2 = new THREE.Color();
    if (activeCard) {
      const c1 = new THREE.Color(activeCard.userData.accentColor);
      const c2 = new THREE.Color(activeCard.userData.bgColor);
      const c3 = new THREE.Color(activeCard.userData.altColor || '#fff');
      const cycle = (Math.sin(t * 1.5) + 1) / 2;
      rColor1.lerpColors(c1, c2, cycle);
      rColor2.lerpColors(c2, c3, 1 - cycle);
      rHemi = ftt(0.1, 0.0);
      rDir = ftt(0.1, 0.0);
    } else {
      rColor1.setHSL((t * 0.1) % 1, 0.9, 0.6);
      rColor2.setHSL(((t * 0.1) + 0.5) % 1, 0.9, 0.6);
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
    ambientLight.color.lerp(new THREE.Color(0xffb060), 0.05);
    cameraLight.intensity += (targetCamLight - cameraLight.intensity) * 0.05;
    cameraLight.color.lerp(new THREE.Color(0xffb878), 0.05);

    tColor1.lerpColors(dColor1, rColor1, L);
    tColor2.lerpColors(dColor2, rColor2, L);

    const az = controls.getAzimuthalAngle();
    dirLight.position.set(Math.sin(az) * 100, 100, Math.cos(az) * 100);
    // Position the amber up and ~70° off to the right of the camera, aimed at
    // origin → light travels diagonally down from upper-right to lower-left
    // across the cards. Grazes instead of washing.
    const azOff = az + Math.PI / 2.5;
    fillFrontAmber.position.set(Math.sin(azOff) * 35, 22, Math.cos(azOff) * 35);
    pointLight1.color.lerp(tColor1, 0.03);
    neonTop.material.color.lerp(tColor1, 0.03);
    neonTop.material.emissive.lerp(tColor1, 0.03);
    pointLight2.color.lerp(tColor2, 0.03);
    neonBot.material.color.lerp(tColor2, 0.03);
    neonBot.material.emissive.lerp(tColor2, 0.03);
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
      const tgt = new THREE.Color(0xffd580).lerp(new THREE.Color(activeCard.userData.accentColor), 0.15);
      ledMat.color.lerp(tgt, 0.1);
      localLed1.color.lerp(tgt, 0.1);
      localLed2.color.lerp(tgt, 0.1);

      // Multiple staggered tracker pairs sweep both directions on the rim.
      const TRACKER_SPEED = 0.4; // cycles per second
      const thetaActive = activeCard.userData.theta;
      for (const tr of trackers) {
        tr.mesh.visible = true;
        const progress = (t * TRACKER_SPEED + tr.offset) % 1;
        const ang = thetaActive + tr.dir * Math.PI * (1 - progress);
        tr.mesh.position.set(Math.sin(ang) * TRACKER_R, TRACKER_Y, Math.cos(ang) * TRACKER_R);
        tr.light.intensity = 3 + Math.sin(progress * Math.PI) * 4;
        tr.light.color.lerp(tgt, 0.1);
      }
      trackerMat.color.lerp(tgt, 0.1);
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
    clearInterval(pollInterval);
    introTimers.forEach(clearTimeout);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('resize', onResize);
    renderer.domElement.removeEventListener('wheel', onWheel);
    camera.remove(buttonRow);
    scene.remove(camera);
    renderer.dispose();
    container.removeChild(renderer.domElement);
  };
}
