// Browser-native prefs I/O — avoids Tish compile quirks (?? null on object
// values, Object.keys on patches) clobbering stored settings with null.
;(function () {
  const KEY = "jukebox_prefs"

  function load() {
    try {
      const raw = localStorage.getItem(KEY)
      if (!raw) return {}
      const p = JSON.parse(raw)
      return p && typeof p === "object" ? p : {}
    } catch {
      return {}
    }
  }

  function save(patch) {
    if (!patch || typeof patch !== "object") return
    try {
      const out = load()
      for (const k of Object.keys(patch)) {
        const v = patch[k]
        if (v !== null && v !== undefined) out[k] = v
      }
      localStorage.setItem(KEY, JSON.stringify(out))
    } catch {
      /* quota / private mode */
    }
  }

  globalThis.__jukePrefs = { load, save, KEY }
})()
