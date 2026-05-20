# @spacedevin/juke-bridges

Browser bundle for the jukebox 3D drum scene. Extracted from `app/jukebox.tsx` (`initThree`) so the Tish/Lattish runtime can load Three.js + Tone without pulling in the full Next.js app.

## Build

```bash
cd packages/bridges
npm install
npm run build
```

Output: `dist/vendor.js` (IIFE). Load it in the host page, then call:

```js
const { dispose, mode } = window.__jukeBridge.createJukeboxScene(container, {
  tracks: [],
  nowItem: null,
  onActiveChange: (active) => {},
  onPlaybackError: (msg) => console.warn(msg),
  lighting: 0.5,
  zoom: 0,
  spin: 0,
  debug: false,
  showCategories: true,
  zoomTight: 0.95,
  zoomFlat: 0,
  audioEnabled: true,
  shuffle: true,
  rows: 10,
})
```

## Spotify bridge

Playback goes through a lazy getter — the host must set `window.__jukeSpotify` before user interaction:

```js
window.__jukeSpotify = {
  play(uri, contextUri) { /* ... */ },
  nowPlaying() { /* ... */ },
  setShuffle(enabled) { /* ... */ },
  addToQueue(uri) { /* ... */ },
}
```

## Card art

`three-scene.js` imports `generateCardArt` and `xmur3` from `@spacedevin/juke-cards`. That package is **external** at bundle time; the host must provide it (separate script or alias) when loading `dist/vendor.js`.

## Layout

| File | Role |
|------|------|
| `src/three-scene.js` | `createJukeboxScene` + full drum renderer |
| `src/tone-audio.js` | Tone.js chime/hum (`createToneAudio`) |
| `src/vendor-entry.js` | Sets `window.__jukeBridge` |

## Dependencies

- [three](https://threejs.org/) — scene, instanced cards, OrbitControls
- [tone](https://tonejs.github.io/) — selection sound
- `@spacedevin/juke-cards` (peer) — procedural card textures
