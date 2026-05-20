// View preferences persisted to localStorage:
//   - spin            ←/→ arrow-key auto-rotation rate (rad/sec)
//   - rows            ↑/↓ arrow-key row count (4..20)
//   - lighting        vertical-drag blend (0 diner ↔ 1 rink)
//   - showCategories  'C' key toggle for bottom-rim labels
//
// Saves are debounced so continuous inputs (lighting drag) don't hammer
// localStorage on every pointermove sample.

const KEY = 'jukebox_prefs';
const SAVE_DEBOUNCE_MS = 250;

export type Prefs = {
  spin?: number;
  rows?: number;
  lighting?: number;
  showCategories?: boolean;
  zoomTight?: number;   // tightDist multiplier (0.4..1.2, default 0.95)
  zoomFlat?: number;    // telephoto-flatness at zoom=1 (0..1, default 0)
  audioEnabled?: boolean; // 'M' key + settings toggle for click + hum; default true
};

export function loadPrefs(): Prefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let pending: Prefs = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  saveTimer = null;
  try {
    const existing = loadPrefs();
    localStorage.setItem(KEY, JSON.stringify({ ...existing, ...pending }));
  } catch {}
  pending = {};
}

export function savePrefs(patch: Prefs) {
  pending = { ...pending, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

// Force a synchronous flush — call from unload/visibility-hidden handlers so
// in-flight debounced writes don't get lost.
export function flushPrefs() {
  if (saveTimer) clearTimeout(saveTimer);
  if (Object.keys(pending).length) flush();
}
