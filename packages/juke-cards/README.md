# Card Art Generator

`lib/card-art.ts` is a standalone procedural-graphics module that renders **256×100 px "jukebox slot card"** artwork to an `HTMLCanvasElement`. It powers every card on the juke.sh drum, but it has no dependency on Three.js, React, or anything else in the app — drop it into any browser project that has a `<canvas>` API.

## TL;DR

```ts
import { generateCardArt } from './card-art';

const { canvas, accent, bg, alt } = generateCardArt({
  titleA: 'JOHNNY B',
  titleB: 'GOODE',
  artist: 'Chuck Berry',
  code: 'A1',
});

document.body.appendChild(canvas);
```

That's it. The same `(titleA + artist + code)` input always produces the same card — the generator is fully deterministic via a 32-bit seeded RNG.

## API

### `generateCardArt(song: CardSong): CardArt`

```ts
interface CardSong {
  titleA: string;     // headline title (printed largest in most layouts)
  titleB: string;     // secondary title (the "B-side")
  artist: string;
  code: string;       // short slot code, e.g. "A1", "K12"
  source?: 'now' | 'queue' | 'playlist';
                      // optional left-edge stripe colour:
                      //   'now'   → green stripe (currently playing)
                      //   'queue' → amber stripe (in the user's queue)
                      //   any other / undefined → no stripe
}

interface CardArt {
  canvas: HTMLCanvasElement;  // 256×100, ready to use
  accent: string;             // palette[2] — primary accent hex
  bg: string;                 // palette[0] — card background hex
  alt: string;                // palette[3] — alt accent hex
}
```

### `xmur3(seed: string): () => number`

The same Mulberry-style 32-bit hash the generator uses internally. Exposed so callers can chain reproducible randomness in their own code (juke.sh uses it to seed the env-map texture).

### `getContrast(hex: string): string`

Given a `#rrggbb` colour, returns `'#000000'` or `'#ffffff'` — whichever has the higher contrast (using the standard 299/587/114 luma weights).

### Mutable exports

```ts
export const palettes: string[][];      // 35 × 4 colours
export const displayFonts: string[];    // 19 headline faces
export const scriptFonts: string[];     // 10 script faces
export const codeFonts: string[];       // 5 monospaced-feel faces (slot code)
export const infoFonts: string[];       // 9 body / fine-print faces
```

These are deliberately `let`-equivalent (exported arrays you can mutate in place). Drop in your own palette or font list before calling `generateCardArt`:

```ts
import { palettes, generateCardArt } from './card-art';

palettes.length = 0;
palettes.push(
  ['#1b1b1b', '#e1e1e1', '#ff4500', '#999999'], // monochrome with one accent
  ['#0a0a0a', '#fafafa', '#00d4ff', '#cccccc'],
);

const { canvas } = generateCardArt({ titleA: 'TEST', titleB: 'TONE', artist: '—', code: 'Z1' });
```

## How the generator works

Each call picks four independent random style indices from the seeded RNG and stamps the card in four layers:

| Layer | Range | What it draws |
| ----- | ----- | ------------- |
| **Background** | `0–45` | Solid fills and patterns — split, stripes, checks, rays, chevron, wavy 70s bands, scanlines, etc. |
| **Decor** | `0–45` | Overlay graphic — giant star, watermark code, vinyl, mic, UFO, mountains, divider lines, etc. |
| **Border** | `0–14` | Frame around the central typography area. Some borders also place an inset background, which the typo layer respects. |
| **Layout** | `0–46` | Typography arrangement — 47 distinct compositions for titleA / titleB / artist / code. |

Plus per-card random selections from `palettes`, `displayFonts`, `scriptFonts`, `codeFonts`, `infoFonts`.

Typography is drawn on a separate offscreen canvas and composited onto the card. **Solid flat cards** (simple background + no icons/illustrations + plain border + standard layout) get a pixel-level WCAG contrast pass that flips low-contrast text to black or white. **Patterned or illustrated cards** use hard text shadows instead.

After the four layers, an optional **left-edge stripe** is painted to encode `song.source`, and a **1500-pixel paper-grain noise overlay** is dithered on top to break up the flat fills.

Total combinatorial space: `46 × 46 × 15 × 47 × 35 palettes × (19 × 10 × 5 × 9 fonts) ≈ 450 billion` distinct cards, so collisions are vanishingly unlikely.

## Determinism

The seed is `titleA + artist + code`. **Change any of those and you get a different card**; leave them stable and every call returns the same artwork. Useful for:

- snapshot tests (compare canvas data URLs)
- server-side rendering (use [`canvas`](https://www.npmjs.com/package/canvas) to polyfill `document.createElement('canvas')` in Node)
- skipping regeneration in caches

`titleB` and `source` do **not** contribute to the seed, so changing the B-side or moving a track between queue/playlist won't reshuffle the layout — only repaint the relevant text + stripe.

## Fonts

Layouts reference Google Font families by name (`'Limelight'`, `'Anton'`, `'Bebas Neue'`, etc.). The generator never loads them — you're responsible for loading whatever set you want in your host page, e.g.:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Bebas+Neue&family=Limelight&family=Monoton&family=Pacifico&family=Lobster&family=Yellowtail&family=Satisfy&family=Permanent+Marker&family=Shrikhand&family=Fascinate&family=Righteous&family=Fjalla+One&family=Rampart+One&family=Rubik+Mono+One&family=Abril+Fatface&family=Bungee&family=Bangers&family=Erica+One&family=Fugaz+One&family=Ultra&family=Vampiro+One&family=Chicle&family=Russo+One&family=Sigmar+One&family=Fascinate+Inline&family=Damion&family=Cookie&family=Leckerli+One&family=Courier+Prime:wght@400;700&family=Oswald&family=Space+Mono&family=Special+Elite&family=Cinzel&family=Playfair+Display&family=Poiret+One&family=Arimo:wght@400;700&family=Corben&display=swap">
```

If a face isn't loaded the canvas falls back to the browser's default (typically serif), which looks wrong. juke.sh calls `preloadCardFonts()` before the first render — recommended for any caller that cares about pixel-perfect output on desktop browsers.

## Three.js integration

The juke.sh app wraps the canvas in a `CanvasTexture`:

```ts
import * as THREE from 'three';
import { generateCardArt } from '@/lib/card-art';

function generateCardTexture(song) {
  const { canvas, accent, bg, alt } = generateCardArt(song);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.minFilter = THREE.LinearFilter;
  return { texture, accent, bg, alt };
}
```

That's the entire integration. Everything else (placement, lighting, the LED-edge highlight) lives in `app/jukebox.tsx`.

## Standalone smoke test

Drop a `<canvas>` page in front of it without any framework:

```html
<!doctype html>
<meta charset="utf-8">
<title>card-art preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Bebas+Neue&family=Limelight&family=Monoton&family=Pacifico&family=Lobster&family=Yellowtail&family=Satisfy&family=Permanent+Marker&family=Shrikhand&family=Fascinate&family=Righteous&family=Fjalla+One&family=Rampart+One&family=Rubik+Mono+One&family=Abril+Fatface&family=Bungee&family=Bangers&family=Erica+One&family=Fugaz+One&family=Ultra&family=Vampiro+One&family=Chicle&family=Russo+One&family=Sigmar+One&family=Fascinate+Inline&family=Damion&family=Cookie&family=Leckerli+One&family=Courier+Prime:wght@400;700&family=Oswald&family=Space+Mono&family=Special+Elite&family=Cinzel&family=Playfair+Display&family=Poiret+One&family=Arimo:wght@400;700&family=Corben&display=swap">
<body style="background:#111;padding:20px;display:grid;grid-template-columns:repeat(4,256px);gap:8px;">
<script type="module">
  import { generateCardArt, preloadCardFonts } from './lib/card-art.js';
  await preloadCardFonts();
  for (let i = 0; i < 32; i++) {
    const { canvas } = generateCardArt({
      titleA: `Track ${i + 1}`,
      titleB: 'B-Side',
      artist: 'Generated',
      code: 'A' + (i + 1),
    });
    document.body.appendChild(canvas);
  }
</script>
```

## Reference

- Source: [`lib/card-art.ts`](../lib/card-art.ts)
- Lineage: adapted from [`assets/spin20.html`](../assets/spin20.html) (was spin7)
