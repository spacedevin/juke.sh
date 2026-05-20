// @ts-nocheck
'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
// Spin is denominated in CARDS PER SECOND — perceived scroll rate is
// constant across drum sizes (a 1000-card drum and a 100-card drum both move
// one card past the camera per second at spin=1).
const SPIN_MAX = 10;       // ±10 cards/s
const SPIN_STEP = 0.25;    // ←/→ key nudge
const clampSpin = (n: number) => Math.max(-SPIN_MAX, Math.min(SPIN_MAX, n));
// Tight-zoom multiplier. Lower = camera pulls closer past height-fit,
// effectively cropping the gold rim chrome off the top/bottom. Higher =
// reveals more chrome / breathing room.
const ZOOM_TIGHT_MIN = 0.4;
const ZOOM_TIGHT_MAX = 1.2;
const ZOOM_TIGHT_DEFAULT = 0.95;
const clampZoomTight = (n: number) => Math.max(ZOOM_TIGHT_MIN, Math.min(ZOOM_TIGHT_MAX, n));
// Telephoto-flatness applied at zoom=1: 0 = normal 12° tight, 1 = ultra-tele
// ~2° (near-orthographic, perspective looks completely flat). Camera distance
// auto-compensates so cards stay the same size on screen — only the depth /
// foreshortening collapses.
const TIGHT_FOV_NORMAL = 12;
const TIGHT_FOV_FLAT = 2;
const ZOOM_FLAT_STEP = 0.2;
const clampZoomFlat = (n: number) => Math.max(0, Math.min(1, n));

function SettingsModal({
  modeRef,
  rows,
  onChangeRows,
  onClose,
}: {
  modeRef: { current: { spin: number; showCategories: boolean; zoomTight: number; zoomFlat: number } };
  rows: number;
  onChangeRows: (n: number) => void;
  onClose: () => void;
}) {
  // Mirror modeRef into local state so the sliders re-render. Writes go
  // straight back to modeRef + savePrefs so the live scene updates instantly.
  const [spin, setSpin] = useState(modeRef.current.spin);
  const [showCategories, setShowCategories] = useState(modeRef.current.showCategories);
  const [zoomTight, setZoomTight] = useState(modeRef.current.zoomTight);
  const [zoomFlat, setZoomFlat] = useState(modeRef.current.zoomFlat);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = <K extends 'spin' | 'showCategories' | 'zoomTight' | 'zoomFlat'>(k: K, v: any) => {
    (modeRef.current as any)[k] = v;
    savePrefs({ [k]: v } as any);
  };

  return (
    <div className="center-screen settings-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">SETTINGS</div>
        <div className="modal-sub">5-tap anywhere to reopen · ESC to close</div>

        <label className="set-row">
          <div className="set-label">
            <span>ROTATION SPEED</span>
            <span className="set-val">{spin.toFixed(2)} cards/s</span>
          </div>
          <input
            type="range" min={-SPIN_MAX} max={SPIN_MAX} step={SPIN_STEP} value={spin}
            onChange={(e) => { const v = +e.target.value; setSpin(v); update('spin', v); }}
          />
          <button className="set-zero" onClick={() => { setSpin(0); update('spin', 0); }} title="Stop">⏹</button>
        </label>

        <label className="set-row">
          <div className="set-label">
            <span>ROWS PER COLUMN</span>
            <span className="set-val">{rows}</span>
          </div>
          <input
            type="range" min={MIN_ROWS} max={MAX_ROWS} step={1} value={rows}
            onChange={(e) => onChangeRows(clampRows(+e.target.value))}
          />
        </label>

        <label className="set-row">
          <div className="set-label">
            <span>ZOOM-IN TIGHTNESS</span>
            <span className="set-val">{zoomTight.toFixed(2)}×</span>
          </div>
          <input
            type="range" min={ZOOM_TIGHT_MIN} max={ZOOM_TIGHT_MAX} step={0.05} value={zoomTight}
            onChange={(e) => { const v = +e.target.value; setZoomTight(v); update('zoomTight', v); }}
          />
        </label>
        <div className="set-hint">Lower = crops chrome / cards fill more of the screen. Z / X keys nudge this too.</div>

        <label className="set-row">
          <div className="set-label">
            <span>ZOOM-IN FLATNESS</span>
            <span className="set-val">{Math.round(zoomFlat * 100)}%</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.05} value={zoomFlat}
            onChange={(e) => { const v = +e.target.value; setZoomFlat(v); update('zoomFlat', v); }}
          />
        </label>
        <div className="set-hint">Higher = longer telephoto lens, cards look flatter / less 3D when zoomed in. V key cycles too.</div>

        <label className="set-row set-toggle">
          <span>CATEGORY LABELS</span>
          <input
            type="checkbox" checked={showCategories}
            onChange={(e) => { const v = e.target.checked; setShowCategories(v); update('showCategories', v); }}
          />
        </label>

        <div className="modal-actions">
          <button className="sp-btn" onClick={onClose}>DONE</button>
        </div>
      </div>
    </div>
  );
}

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
  const [showSettings, setShowSettings] = useState(false);
  const modeRef = useRef<{
    lighting: number; // 0 = classic diner, 1 = roller rink
    zoom: number;     // 0 = fit-to-screen, 1 = zoom-to-cards
    spin: number;     // radians/SECOND auto-orbit (0 = off). Time-based so
                      // the speed stays identical at 60 vs 120 fps displays.
                      // Arrow keys nudge this up/down; defaults to 0.
    debug: boolean;   // procedural tracks, no Spotify API
    showCategories: boolean; // bottom-rim category labels toggled by 'C'
    zoomTight: number; // tightDist multiplier — Z/X keys + settings slider
    zoomFlat: number;  // telephoto-flatness at zoom=1 — V key + settings slider
    goToActiveCard?: () => void;
  }>({
    lighting: clampUnit(initialPrefs.current.lighting ?? 1),
    zoom: 0,
    spin: clampSpin(initialPrefs.current.spin ?? 0),
    debug,
    showCategories: initialPrefs.current.showCategories ?? true,
    zoomTight: clampZoomTight(initialPrefs.current.zoomTight ?? ZOOM_TIGHT_DEFAULT),
    zoomFlat: clampZoomFlat(initialPrefs.current.zoomFlat ?? 0),
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
        modeRef.current.spin = clampSpin(modeRef.current.spin + SPIN_STEP);
        savePrefs({ spin: modeRef.current.spin });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        modeRef.current.spin = clampSpin(modeRef.current.spin - SPIN_STEP);
        savePrefs({ spin: modeRef.current.spin });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setRows(r => { const n = Math.min(MAX_ROWS, r + 1); savePrefs({ rows: n }); return n; });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setRows(r => { const n = Math.max(MIN_ROWS, r - 1); savePrefs({ rows: n }); return n; });
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        // Z = tighter (crop more chrome)
        modeRef.current.zoomTight = clampZoomTight(modeRef.current.zoomTight - 0.05);
        savePrefs({ zoomTight: modeRef.current.zoomTight });
      } else if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        // X = looser (reveal more chrome)
        modeRef.current.zoomTight = clampZoomTight(modeRef.current.zoomTight + 0.05);
        savePrefs({ zoomTight: modeRef.current.zoomTight });
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        // V = step telephoto flatness up; wraps to 0 after 1.0 so a single
        // key cycles through the full range.
        let next = modeRef.current.zoomFlat + ZOOM_FLAT_STEP;
        if (next > 1.0001) next = 0;
        modeRef.current.zoomFlat = clampZoomFlat(next);
        savePrefs({ zoomFlat: modeRef.current.zoomFlat });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pointer-release housekeeping:
  //  • persist the lighting blend (initThree mutates modeRef.lighting
  //    continuously during a vertical drag, debouncing saves at the lib)
  //  • count 5 fast taps to pop the Settings modal — a mobile-friendly
  //    alternative to keyboard shortcuts.
  const TAP_BURST_MS = 800;
  const TAP_MOVE_MAX = 8;
  const TAP_DURATION_MAX = 250;
  const tapTimes = useRef<number[]>([]);
  let pdAt = 0, pdX = 0, pdY = 0;
  useEffect(() => {
    const onDown = (e: PointerEvent) => { pdAt = Date.now(); pdX = e.clientX; pdY = e.clientY; };
    const onUp = (e: PointerEvent) => {
      savePrefs({ lighting: modeRef.current.lighting });
      const dur = Date.now() - pdAt;
      const dist = Math.hypot(e.clientX - pdX, e.clientY - pdY);
      if (dur > TAP_DURATION_MAX || dist > TAP_MOVE_MAX) return;
      const now = Date.now();
      tapTimes.current = [...tapTimes.current, now].filter(t => now - t < TAP_BURST_MS).slice(-5);
      if (tapTimes.current.length >= 5) {
        tapTimes.current = [];
        setShowSettings(true);
      }
    };
    const onHide = () => {
      savePrefs({
        lighting: modeRef.current.lighting,
        spin: modeRef.current.spin,
        showCategories: modeRef.current.showCategories,
        zoomTight: modeRef.current.zoomTight,
      });
      flushPrefs();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pointerdown', onDown);
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
                ← → ROTATION &nbsp;•&nbsp; ↑ ↓ ROWS &nbsp;•&nbsp; Z X TIGHTNESS &nbsp;•&nbsp; V FLATNESS
              </div>
              <div className="instruction-subtitle">5-TAP FOR SETTINGS</div>
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

      {showSettings && (
        <SettingsModal
          modeRef={modeRef}
          rows={rows}
          onChangeRows={(n) => { setRows(n); savePrefs({ rows: n }); }}
          onClose={() => setShowSettings(false)}
        />
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

        /* Settings modal */
        .settings-backdrop { background: rgba(0,0,0,0.55); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
        .modal.modal-narrow { width: min(360px, 92vw); padding: 18px; gap: 8px; }
        .set-row { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
        .set-row.set-toggle { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
        .set-label { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; color: #ccc; letter-spacing: 1px; }
        .set-val { color: #00ff88; font-variant-numeric: tabular-nums; }
        .set-row input[type="range"] {
          -webkit-appearance: none; appearance: none;
          width: 100%; height: 4px; background: rgba(0,255,136,0.18); border-radius: 999px; outline: none;
        }
        .set-row input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 20px; height: 20px; border-radius: 50%;
          background: #00ff88; cursor: pointer; border: none;
          box-shadow: 0 0 8px rgba(0,255,136,0.5);
        }
        .set-row input[type="range"]::-moz-range-thumb {
          width: 20px; height: 20px; border-radius: 50%;
          background: #00ff88; cursor: pointer; border: none;
          box-shadow: 0 0 8px rgba(0,255,136,0.5);
        }
        .set-zero {
          align-self: flex-end; margin-top: -4px;
          background: transparent; color: #00ff88;
          border: 1px solid rgba(0,255,136,0.45); border-radius: 999px;
          font-family: inherit; font-size: 12px;
          width: 32px; height: 28px; cursor: pointer;
        }
        .set-zero:hover { background: rgba(0,255,136,0.12); }
        .set-row.set-toggle input[type="checkbox"] {
          -webkit-appearance: none; appearance: none;
          width: 46px; height: 26px; border-radius: 999px;
          background: rgba(0,255,136,0.18);
          border: 1px solid rgba(0,255,136,0.4);
          position: relative; cursor: pointer;
        }
        .set-row.set-toggle input[type="checkbox"]::after {
          content: ''; position: absolute; top: 2px; left: 2px;
          width: 20px; height: 20px; border-radius: 50%;
          background: #00ff88; transition: transform 0.15s;
          box-shadow: 0 0 8px rgba(0,255,136,0.5);
        }
        .set-row.set-toggle input[type="checkbox"]:checked::after { transform: translateX(20px); }
        .set-hint { color: #888; font-size: 10px; letter-spacing: 0.5px; margin: -6px 0 0 0; text-align: left; line-height: 1.5; }
      `}</style>
    </>
  );
}

function initThree(
  container: HTMLDivElement,
  tracks: any[],
  nowItem: any,
  onActiveChange: (hasActive: boolean) => void,
  mode: { lighting: number; zoom: number; spin: number; debug: boolean; showCategories: boolean; zoomTight: number; zoomFlat: number; goToActiveCard?: () => void },
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
  // logarithmicDepthBuffer = much better depth precision across wide ranges.
  // Needed because at max zoomFlat the FOV drops to ~2° → camera pulls back
  // to ~700 units, and the cards-vs-drum 0.03-unit gap z-fights with the
  // standard 24-bit nonlinear depth buffer (the dark drum #111 shows through
  // the cards). Tiny per-pixel shader cost; eliminates the artifact entirely.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
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
  controls.dampingFactor = 0.1; // only affects auto-orbit / damping internals;
                                // drag rotation is handled by us directly below
  controls.minPolarAngle = Math.PI / 2;
  controls.maxPolarAngle = Math.PI / 2;
  controls.enableZoom = false;   // we drive zoom ourselves via mode.zoom
  controls.enablePan = false;    // two-finger drag should never pan the camera
  // CRITICAL: we drive horizontal rotation ourselves (see onPointerMove +
  // momentum coast in animate). OrbitControls' damping pipeline buffered each
  // move event across many frames AND decayed pending input symmetrically,
  // which felt like the drum lagged the finger AND lost momentum on release.
  // Direct camera-azimuth writes make drag pixel-perfect, and we track
  // pointer velocity for a real fling/coast.
  controls.enableRotate = false;

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
  // Manual shadow-map updates. Three.js otherwise re-renders the entire scene
  // into a 2048² depth target every frame. We instead set `needsUpdate = true`
  // only when something that affects the shadow has actually moved (camera
  // azimuth → dirLight repositions; drum rotation → cards move; new card
  // placed). At rest that's a 20-30% frame-time saving with zero visible
  // change — the shadow looks identical because the geometry hasn't moved.
  dirLight.shadow.autoUpdate = false;
  dirLight.shadow.needsUpdate = true; // first frame
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
  // rotateSpeed is recomputed per-frame in animate() — see updateRotateSpeed —
  // because true 1:1 drag depends on the camera's current distance + FOV,
  // both of which change with `mode.zoom`. A static value can't be both
  // comfortable at fit-zoom AND not whip-past at telephoto zoom.
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

  // ----- Brackets (baked into 3 merged geometries instead of ~80 meshes) -----
  // Each bracket was a Group of 1 base + 1–2 chrome accents, positioned in a
  // ring. None of them move relative to each other, so we bake the per-column
  // transform into the geometry once and merge by material. 36 cols × ~2.5
  // sub-meshes = ~90 draw calls → 3 draw calls (one per material).
  const tealGeos: THREE.BufferGeometry[] = [];
  const aluminumGeos: THREE.BufferGeometry[] = [];
  const chromeGeos: THREE.BufferGeometry[] = [];
  const Y_UP = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < COLS; i++) {
    const theta = i * COL_ANGLE;
    const groupMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.sin(theta) * (R + 0.12), 0, Math.cos(theta) * (R + 0.12)),
      new THREE.Quaternion().setFromAxisAngle(Y_UP, theta),
      new THREE.Vector3(1, 1, 1),
    );
    if (i % 2 === 0) {
      // Teal base centered in the bracket
      const b = new THREE.BoxGeometry(0.5, HEIGHT_TOTAL - 2, 0.4);
      b.applyMatrix4(groupMatrix);
      tealGeos.push(b);
      // Two chrome pipes flanking the front face
      for (const dx of [-0.15, 0.15]) {
        const p = new THREE.BoxGeometry(0.04, HEIGHT_TOTAL - 2, 0.04);
        p.applyMatrix4(new THREE.Matrix4().multiplyMatrices(groupMatrix, new THREE.Matrix4().setPosition(dx, 0, 0.2)));
        chromeGeos.push(p);
      }
    } else {
      // Aluminum base + single chrome spine
      const b = new THREE.BoxGeometry(0.3, HEIGHT_TOTAL - 2, 0.15);
      b.applyMatrix4(groupMatrix);
      aluminumGeos.push(b);
      const s = new THREE.BoxGeometry(0.1, HEIGHT_TOTAL - 2, 0.08);
      s.applyMatrix4(new THREE.Matrix4().multiplyMatrices(groupMatrix, new THREE.Matrix4().setPosition(0, 0, 0.1)));
      chromeGeos.push(s);
    }
  }
  const tealMerged = mergeGeometries(tealGeos, false);
  const aluminumMerged = mergeGeometries(aluminumGeos, false);
  const chromeBracketsMerged = mergeGeometries(chromeGeos, false);
  // mergeGeometries copies vertex data, so the source geometries are dead weight now.
  for (const g of [...tealGeos, ...aluminumGeos, ...chromeGeos]) g.dispose();
  for (const merged of [tealMerged, aluminumMerged, chromeBracketsMerged]) {
    if (!merged) continue;
    const mat = merged === tealMerged ? tealMaterial
              : merged === aluminumMerged ? aluminumMat
              : chromeMat;
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true; m.receiveShadow = true;
    jukeboxGroup.add(m);
  }

  // ----- Row divider torii (ROWS+1 of them, all on whiteBracketMat) → 1 mesh
  const ringGeos: THREE.BufferGeometry[] = [];
  for (let r = 0; r <= ROWS; r++) {
    const y = startY - r * ROW_SPACING + ROW_SPACING / 2;
    // 8×32 segments instead of 16×64 — these are tiny rings seen edge-on most
    // of the time, the smoothness drop is invisible. 4× fewer triangles each.
    const g = new THREE.TorusGeometry(R + 0.08, 0.1, 8, 32);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
      new THREE.Vector3(1, 1, 1),
    ));
    ringGeos.push(g);
  }
  const ringsMerged = mergeGeometries(ringGeos, false);
  for (const g of ringGeos) g.dispose();
  if (ringsMerged) {
    const ringsMesh = new THREE.Mesh(ringsMerged, whiteBracketMat);
    ringsMesh.castShadow = true; ringsMesh.receiveShadow = true;
    jukeboxGroup.add(ringsMesh);
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

  // Cards as InstancedMesh + texture atlas.
  // Before: COLS*ROWS draw calls, one Mesh + Material + CanvasTexture per card.
  // After:  ceil(N / CELLS_PER_ATLAS) draw calls — one InstancedMesh per atlas.
  //         For a 320-card deck that's 1 draw call vs 320. Each card still
  //         renders from a 256×100 region with the same anisotropy and minFilter
  //         as before, so pixel-for-pixel output is identical.
  //
  // Layout: each atlas packs up to 16 × 40 = 640 cells in a 4096² canvas.
  // A slot (c, r) maps deterministically to a fixed (atlasIdx, cellIdx) so
  // "recycling" a card via placeIncoming just redraws its existing cell in the
  // existing atlas — no instance reassignment needed.
  const ATLAS_SIZE = 4096;
  const CELL_W = 256;
  const CELL_H = 100;
  const COLS_PER_ATLAS = Math.floor(ATLAS_SIZE / CELL_W); // 16
  const ROWS_PER_ATLAS = Math.floor(ATLAS_SIZE / CELL_H); // 40
  const CELLS_PER_ATLAS = COLS_PER_ATLAS * ROWS_PER_ATLAS; // 640
  const totalSlots = COLS * ROWS;
  const atlasCount = Math.max(1, Math.ceil(totalSlots / CELLS_PER_ATLAS));

  // Looks like a Three.js Mesh's `.userData` sub-object to every consumer
  // (selectCard, ledMoveTo, the animate-loop lighting block) so we don't have
  // to rewrite every `card.userData.X` access — just swap the backing object.
  type CardRef = {
    userData: {
      isCard: true;
      song: any;
      baseY: number;
      theta: number;
      c: number;
      r: number;
      accentColor: string;
      bgColor: string;
      altColor: string;
      accentCol: THREE.Color;
      bgCol: THREE.Color;
      altCol: THREE.Color;
    };
    atlasIdx: number;
    cellIdx: number;
  };

  type Atlas = {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    texture: THREE.CanvasTexture;
    mesh: THREE.InstancedMesh;
    capacity: number;
    cellRefs: (CardRef | null)[];
  };

  const cards: CardRef[] = [];
  // O(1) URI → card lookup; kept in sync with `cards` in buildCard / placeIncoming.
  const cardByUri = new Map<string, CardRef>();
  let activeCard: CardRef | null = null;
  const atlases: Atlas[] = [];
  // Raycast targets — each entry is the InstancedMesh for one atlas.
  const cardInstancedMeshes: THREE.InstancedMesh[] = [];

  // Per-instance UV rect (offsetX, offsetY, scaleX, scaleY). Determined entirely
  // by the cell's grid position in the atlas. Inset by 0.5 px on every side so
  // linear filtering at the cell edge never reaches outside this cell (would
  // otherwise show a thin colored bleed at every card border).
  function makeAtlasGeo(capacity: number) {
    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    const aUvRect = new Float32Array(capacity * 4);
    const inset = 0.5 / ATLAS_SIZE;
    for (let i = 0; i < capacity; i++) {
      const col = i % COLS_PER_ATLAS;
      const row = Math.floor(i / COLS_PER_ATLAS);
      // WebGL UV origin is bottom-left; canvas is top-down. Row 0 sits at
      // canvas y∈[0, CELL_H], which is UV-y∈[1 - CELL_H/ATLAS_SIZE, 1].
      aUvRect[i * 4 + 0] = (col * CELL_W) / ATLAS_SIZE + inset;
      aUvRect[i * 4 + 1] = 1 - ((row + 1) * CELL_H) / ATLAS_SIZE + inset;
      aUvRect[i * 4 + 2] = (CELL_W - 1) / ATLAS_SIZE;
      aUvRect[i * 4 + 3] = (CELL_H - 1) / ATLAS_SIZE;
    }
    geo.setAttribute('aUvRect', new THREE.InstancedBufferAttribute(aUvRect, 4));
    return geo;
  }

  function makeAtlasMat(texture: THREE.CanvasTexture) {
    // Same MeshStandardMaterial params as the original per-card material —
    // identical shading.
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute vec4 aUvRect;\n' + shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * aUvRect.zw + aUvRect.xy;
        #endif
        `
      );
    };
    return mat;
  }

  {
    // Build atlases up front. Empty cells get a zero-scale matrix so they
    // don't render; buildCard fills in real matrices as cards arrive.
    const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let a = 0; a < atlasCount; a++) {
      const startSlot = a * CELLS_PER_ATLAS;
      const capacity = Math.min(CELLS_PER_ATLAS, totalSlots - startSlot);
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const ctx = canvas.getContext('2d')!;
      const texture = new THREE.CanvasTexture(canvas);
      // Same filtering as the old per-card CanvasTexture — quality unchanged.
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearFilter;
      const geo = makeAtlasGeo(capacity);
      const mat = makeAtlasMat(texture);
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Default bounding sphere is one card. Skip frustum culling so the
      // InstancedMesh isn't dropped when the camera is close to the drum.
      mesh.frustumCulled = false;
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, hiddenMatrix);
      mesh.instanceMatrix.needsUpdate = true;
      jukeboxGroup.add(mesh);
      cardInstancedMeshes.push(mesh);
      atlases.push({ canvas, ctx, texture, mesh, capacity, cellRefs: Array(capacity).fill(null) });
    }
  }

  function slotToAtlas(c: number, r: number) {
    const idx = c * ROWS + r;
    return { atlasIdx: Math.floor(idx / CELLS_PER_ATLAS), cellIdx: idx % CELLS_PER_ATLAS };
  }

  function stampCell(atlasIdx: number, cellIdx: number, art: HTMLCanvasElement) {
    const atlas = atlases[atlasIdx];
    const col = cellIdx % COLS_PER_ATLAS;
    const row = Math.floor(cellIdx / COLS_PER_ATLAS);
    atlas.ctx.clearRect(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    atlas.ctx.drawImage(art, col * CELL_W, row * CELL_H);
    // needsUpdate is just a flag — Three batches subsequent stamps into a
    // single texSubImage2D before the next render. Stamping 320 cards on init
    // triggers one upload, not 320.
    atlas.texture.needsUpdate = true;
  }

  // Reused across buildCard calls — Object3D allocations aren't free.
  const cardDummy = new THREE.Object3D();

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

  function buildCard(t: any, c: number, r: number): CardRef {
    const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;
    const words = (t.name || '').split(/\s+/).filter(Boolean);
    const half = Math.ceil(words.length / 2);
    const titleA = words.length > 1 ? words.slice(0, half).join(' ') : (t.name || '');
    const titleB = words.length > 1 ? words.slice(half).join(' ') : (t.album || t.name || '');
    const code = letters[c % letters.length] + (r + 1);
    const song = { ...t, titleA, titleB, code };
    const { canvas: art, accent, bg, alt } = generateCardArt(song);
    const { atlasIdx, cellIdx } = slotToAtlas(c, r);
    stampCell(atlasIdx, cellIdx, art);
    const x = Math.sin(theta) * (R + 0.05);
    const z = Math.cos(theta) * (R + 0.05);
    const y = startY - r * ROW_SPACING;
    cardDummy.position.set(x, y, z);
    cardDummy.rotation.set(0, theta, 0);
    cardDummy.scale.set(1, 1, 1);
    cardDummy.updateMatrix();
    const atlas = atlases[atlasIdx];
    atlas.mesh.setMatrixAt(cellIdx, cardDummy.matrix);
    atlas.mesh.instanceMatrix.needsUpdate = true;
    const ref: CardRef = {
      userData: {
        isCard: true, song, baseY: y, theta, c, r,
        // Hex strings (still used by external consumers).
        accentColor: accent, bgColor: bg, altColor: alt,
        // Pre-parsed Color objects — the rink-mode lighting block reads these
        // every frame while the card is active. `set('#abcdef')` parses the
        // string on every call; `copy()` is a 3-float copy.
        accentCol: new THREE.Color(accent),
        bgCol: new THREE.Color(bg),
        altCol: new THREE.Color(alt || '#ffffff'),
      },
      atlasIdx,
      cellIdx,
    };
    atlas.cellRefs[cellIdx] = ref;
    return ref;
  }

  // Bottom-rim category labels as a single InstancedMesh + texture atlas.
  // Before: COLS canvases / textures / materials / draw calls — one per column,
  //         all rendering the same 10 unique strings.
  // After:  1 canvas (CAT_N rows stacked vertically), 1 texture, 1 material,
  //         1 draw call. Each instance picks its row via a per-instance UV-y
  //         offset. Pixels are identical — the canvas is drawn with the same
  //         font, size, and fill as before; only the packing changes.
  {
    const CAT_W = 256, CAT_H = 64, CAT_N = categories.length;
    const catCanvas = document.createElement('canvas');
    catCanvas.width = CAT_W; catCanvas.height = CAT_H * CAT_N;
    const cctx = catCanvas.getContext('2d')!;
    cctx.fillStyle = '#006666'; cctx.fillRect(0, 0, CAT_W, CAT_H * CAT_N);
    cctx.fillStyle = '#ffffff'; cctx.font = "bold 28px 'Oswald'";
    cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    for (let i = 0; i < CAT_N; i++) {
      cctx.fillText(categories[i].toUpperCase(), CAT_W / 2, i * CAT_H + CAT_H / 2);
    }
    const catTex = new THREE.CanvasTexture(catCanvas);
    catTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    catTex.needsUpdate = true;

    // Per-instance UV-y offset. WebGL UV-y origin is bottom-left while the
    // canvas was drawn top-down, so instance c (showing row c % CAT_N) wants
    // its band starting at UV-y = 1 - (rowIdx + 1) / CAT_N.
    const catGeo = new THREE.PlaneGeometry(CARD_W * 0.9, 0.6);
    const aUvOffset = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      aUvOffset[c] = 1 - ((c % CAT_N) + 1) / CAT_N;
    }
    catGeo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(aUvOffset, 1));

    // Reactive to scene lighting (Standard material) AND self-illuminated via
    // emissiveMap so each label has its own dim warm glow.
    const CAT_SCALE_Y = (1 / CAT_N).toFixed(6);
    const catMat = new THREE.MeshStandardMaterial({
      map: catTex,
      emissiveMap: catTex,
      emissive: new THREE.Color(0xffd580),
      emissiveIntensity: 0.35,
      roughness: 0.7,
      metalness: 0.1,
    });
    catMat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute float aUvOffset;\n' + shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv.y = vMapUv.y * ${CAT_SCALE_Y} + aUvOffset;
        #endif
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv.y = vEmissiveMapUv.y * ${CAT_SCALE_Y} + aUvOffset;
        #endif
        `
      );
    };

    const catInstanced = new THREE.InstancedMesh(catGeo, catMat, COLS);
    catInstanced.receiveShadow = true;
    catInstanced.castShadow = false;
    const catDummy = new THREE.Object3D();
    for (let c = 0; c < COLS; c++) {
      const theta = -Math.PI + c * COL_ANGLE + COL_ANGLE / 2;
      catDummy.position.set(Math.sin(theta) * (R + 0.1), -startY - ROW_SPACING, Math.cos(theta) * (R + 0.1));
      catDummy.rotation.set(0, theta, 0);
      catDummy.updateMatrix();
      catInstanced.setMatrixAt(c, catDummy.matrix);
    }
    catInstanced.instanceMatrix.needsUpdate = true;
    categoryGroup.add(catInstanced);
  }

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const idx = c * ROWS + r;
      if (idx >= displayTracks.length) break;
      const t = displayTracks[idx];
      if (!t) { emptySlots.push({ c, r }); continue; }
      const card = buildCard(t, c, r);
      cards.push(card);
      cardByUri.set(card.userData.song.uri, card);
    }
  }

  // Add a new now-playing track. Uses an empty slot if available, otherwise
  // recycles the oldest previously-queued slot. Returns the (existing or new)
  // card for the given URI, or null if none can be placed.
  function placeIncoming(raw: any): CardRef | null {
    const existing = cardByUri.get(raw.uri);
    if (existing) return existing;
    let slot: { c: number; r: number } | undefined;
    if (emptySlots.length > 0) {
      slot = emptySlots.shift();
    } else {
      // Recycle the oldest queued card — but skip the one that's currently
      // playing. Rotate it to the back of the queue and try the next.
      while (queueCards.length > 0 && queueCards[0] === activeCard) {
        queueCards.push(queueCards.shift()!);
      }
      if (queueCards.length > 0) {
        const oldest = queueCards.shift()!;
        slot = { c: oldest.userData.c, r: oldest.userData.r };
        cards.splice(cards.indexOf(oldest), 1);
        cardByUri.delete(oldest.userData.song.uri);
        // The atlas cell gets overwritten by buildCard below — there's no
        // per-card material or texture to dispose anymore.
      }
    }
    if (!slot) return null;
    const card = buildCard(raw, slot.c, slot.r);
    cards.push(card);
    cardByUri.set(card.userData.song.uri, card);
    queueCards.push(card);
    // Force the throttled shadow to re-evaluate next frame so the new card
    // casts shadow without waiting for the camera to move.
    lastShadowAz = NaN;
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
  let downX = 0, downY = 0, downAt = 0, lastX = 0, lastY = 0, isDragging = false;
  let lastTapAt = 0;
  // Momentum state for the horizontal drag → drum rotation. azVelocity is the
  // rotational speed (rad/s) the camera should keep coasting at after release.
  // Sampled from the last pointermove (dx/dt), then decayed each frame in
  // animate via MOMENTUM_FRICTION until it falls below MOMENTUM_EPS.
  let azVelocity = 0;
  let lastMoveTime = 0;
  const MOMENTUM_FRICTION = 3.0; // nepers/sec — ~95% lost in 1s, smooth ice-rink coast
  const MOMENTUM_EPS = 0.001;    // rad/s — below this we just stop
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchBaseDist = 0;
  let pinchBaseZoom = 0;
  let isPinching = false;
  function getXY(event: PointerEvent) {
    return { x: event.clientX, y: event.clientY };
  }
  // Apply a delta azimuth (rad) to the camera by rotating its (x, z) around
  // origin. Preserves both radius and y (polar). Used by drag, momentum, and
  // auto-orbit so they all share one code path.
  function applyAzimuthDelta(delta: number) {
    const az = Math.atan2(camera.position.x, camera.position.z) + delta;
    const r = Math.hypot(camera.position.x, camera.position.z);
    camera.position.x = Math.sin(az) * r;
    camera.position.z = Math.cos(az) * r;
  }
  function onPointerDown(event: any) {
    initAudio();
    // Pull focus back to our container so the canvas / iOS selection halo
    // doesn't steal keyboard input from us.
    container.focus({ preventScroll: true });
    const { x, y } = getXY(event);
    if (event.pointerId !== undefined) activePointers.set(event.pointerId, { x, y });
    downX = x; downY = y; lastX = x; lastY = y; downAt = Date.now();
    isDragging = true;
    // Touching the screen always cancels any in-flight momentum coast — the
    // user clearly wants to grab the drum, not chase it.
    azVelocity = 0;
    lastMoveTime = performance.now();
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
      lastX = x; lastY = y; // keep lasts current so post-pinch deltas don't jump
      return;
    }

    const now = performance.now();
    // Clamp dt — sub-millisecond samples blow up the velocity divisor, and a
    // multi-second gap means the user paused. Either way, treat the sample
    // as a "single-frame" move at ~60Hz so the velocity stays sane.
    const dt = Math.min(0.1, Math.max(0.001, (now - lastMoveTime) / 1000));
    lastMoveTime = now;

    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x;
    lastY = y;

    // Vertical → lighting blend (unchanged).
    mode.lighting = clamp(mode.lighting - dy * 0.003, 0, 1);

    // Horizontal → direct drum rotation. Same 1:1 derivation as the old
    // OrbitControls rotateSpeed math: the frontmost card travels Δθ·R world
    // units, which projects on screen to Δθ·R·viewportH/2 / ((Dcam−R)·tan(vFov/2)).
    // Solving for Δθ such that the projected card motion equals dx pixels:
    //   Δθ = (dx / viewportH) · 2·(Dcam − R)·tan(vFov/2) / R
    // Sign: drag right → camera rotates left in world → drum appears to follow finger.
    if (dx !== 0) {
      const dragDist = Math.max(0.1, camera.position.length() - R);
      const halfVFov = (camera.fov * Math.PI) / 360;
      const deltaAz = -(dx / window.innerHeight) * (2 * dragDist * Math.tan(halfVFov)) / R;
      applyAzimuthDelta(deltaAz);
      // Sample velocity from THIS move event only — captures intent at the
      // moment the finger lifts, ignoring earlier slow exploration.
      azVelocity = deltaAz / dt;
    }
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
    const hits = raycaster.intersectObjects(cardInstancedMeshes);
    if (hits.length) {
      const hit = hits[0];
      const atlasIdx = cardInstancedMeshes.indexOf(hit.object as THREE.InstancedMesh);
      const cellIdx = hit.instanceId;
      const ref = atlasIdx >= 0 && cellIdx != null ? atlases[atlasIdx].cellRefs[cellIdx] : null;
      if (ref) { selectCard(ref); lastTapAt = 0; return; }
    }
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
  // Shadow-update throttling. We trigger a shadow rebuild only when the
  // azimuth (which moves dirLight) or the drum's rotation (which moves the
  // shadow casters) has actually changed since the last shadow render.
  let lastShadowAz = NaN;
  let lastShadowGroupRot = NaN;
  const SHADOW_MOVEMENT_EPS = 0.0005; // ~0.03°

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
    // Single dt for the frame — shared by auto-orbit AND the drag-momentum
    // coast below. clock.getDelta() can only be called once per frame (a
    // second call returns 0), so we capture it once here.
    const dt = clock.getDelta();

    if (mode.spin) {
      // mode.spin is interpreted as CARDS PER SECOND so the perceived scroll
      // rate stays constant across drum sizes (a "1 card/s" setting moves
      // exactly one card past the camera per second regardless of COLS).
      const radPerSec = (mode.spin * 2 * Math.PI) / COLS;
      applyAzimuthDelta(radPerSec * dt);
    }

    // Drag-release momentum. After the user flings the drum, azVelocity is
    // the last sampled finger speed (rad/s). We integrate it into the camera
    // each frame and decay exponentially — `friction` controls how quickly
    // the drum slows to a stop. Dragging again zeros azVelocity (see
    // onPointerDown) so a touch always stops the coast immediately.
    if (!isDragging && azVelocity !== 0) {
      applyAzimuthDelta(azVelocity * dt);
      azVelocity *= Math.exp(-MOMENTUM_FRICTION * dt);
      if (Math.abs(azVelocity) < MOMENTUM_EPS) azVelocity = 0;
    }

    controls.update();
    if (categoryGroup.visible !== mode.showCategories) categoryGroup.visible = mode.showCategories;

    // Single read of az now that controls.update() has finished syncing —
    // reused by the zoom block + the dirLight orbit below. getAzimuthalAngle
    // internally walks a quat→spherical conversion, so caching it dodges that
    // work twice per frame.
    const az = controls.getAzimuthalAngle();

    const dist = camera.position.length();
    scene.fog.near = dist + 30; scene.fog.far = dist + 250;

    // The 1:1 drag math used to live here as `controls.rotateSpeed = ...` —
    // now done inline in onPointerMove via applyAzimuthDelta(), so the value
    // is sampled at the exact moment of input rather than once-per-frame.

    // Continuous zoom: 0 = fit-to-screen (wide FOV, full jukebox in view),
    // 1 = zoom-to-cards (telephoto FOV, height-fit on the cards).
    // Camera FOV + position smoothly lerp toward targets derived from mode.zoom.
    {
      const z = mode.zoom;
      // FOV at max zoom is interpolated from the normal 12° telephoto down
      // toward 2° as zoomFlat→1, giving a flat, near-orthographic perspective.
      // Camera distance compensates via hDist below so card size stays similar.
      const tightFOV = TIGHT_FOV_NORMAL + (TIGHT_FOV_FLAT - TIGHT_FOV_NORMAL) * mode.zoomFlat;
      const targetFOV = 45 + (tightFOV - 45) * z;
      camera.fov += (targetFOV - camera.fov) * 0.12;
      camera.updateProjectionMatrix();
      const vFOV = (camera.fov * Math.PI) / 180;
      // Cache the tan once — hDist and wDist below both use it on the same FOV.
      const tanHalfVFov = Math.tan(vFOV / 2);
      const hDist = (HEIGHT_TOTAL + 1) / (2 * tanHalfVFov);
      const wDist = (R * 2 + 4) / (2 * tanHalfVFov * camera.aspect);
      const fitDist = Math.max(hDist, wDist);
      // At max zoom, pull in past the strict height-fit so cards punch larger
      // in frame (FOV compression alone doesn't change apparent card size).
      const tightDist = hDist * mode.zoomTight;
      const targetDist = fitDist + (tightDist - fitDist) * z;
      const tx = Math.sin(az) * (R + targetDist);
      const tz = Math.cos(az) * (R + targetDist);
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
      // Pre-parsed Color objects (set once in buildCard) — copy() is a 3-float
      // memcpy versus set('#abcdef') which re-parses the hex on every frame.
      _scratchA.copy(activeCard.userData.accentCol);
      _scratchB.copy(activeCard.userData.bgCol);
      _scratchC.copy(activeCard.userData.altCol);
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

    // `az` already cached at the top of the frame.
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
      _scratchA.copy(activeCard.userData.accentCol);
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
    // The previous back-of-drum cull (one JS loop hiding ~40% of cards each
    // frame) is gone — with all cards now in one InstancedMesh there's no
    // per-card draw-call cost left to claw back. The GPU still backface-culls
    // the rear-facing FrontSide planes for free.
    //
    // Shadow refresh trigger. The dirLight tracks the camera azimuth, so the
    // shadow projection changes whenever az changes; the drum rotation moves
    // every card so the shadow casters move with groupRot. When both are still,
    // the previous shadow map is still mathematically correct — skip the pass.
    // placeIncoming() force-triggers an update by NaN-ing lastShadowAz.
    const groupRot = jukeboxGroup.rotation.y;
    if (Math.abs(az - lastShadowAz) > SHADOW_MOVEMENT_EPS ||
        Math.abs(groupRot - lastShadowGroupRot) > SHADOW_MOVEMENT_EPS ||
        Number.isNaN(lastShadowAz)) {
      dirLight.shadow.needsUpdate = true;
      lastShadowAz = az;
      lastShadowGroupRot = groupRot;
    }
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
