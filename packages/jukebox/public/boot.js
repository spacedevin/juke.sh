// Card art is external to vendor.js — register a require shim before loading the IIFE bundle.
import * as jukeCards from "/dist/juke-cards.js"

globalThis.require = (name) => {
  if (name === "@spacedevin/juke-cards") { return jukeCards }
  throw new Error('Dynamic require of "' + name + '" is not supported')
}

// jukebox.js bundles the Lattish runtime via `import from "lattish"` — do not load lattish-runtime.js separately.
await import("/dist/vendor.js")
await import("/dist/jukebox.js")
