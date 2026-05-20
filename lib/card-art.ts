// Procedural card-art generator — renders 256×100 "jukebox slot card"
// graphics onto an HTMLCanvasElement. Standalone module: no Three.js, no
// React, no DOM beyond `document.createElement('canvas')`. Use the returned
// canvas anywhere — wrap in a CanvasTexture for WebGL, draw to an <img>,
// post to a Cloudinary upload, etc.
//
// The output is fully deterministic: the same `(titleA + artist + code)`
// always produces the same card.

/* eslint-disable no-bitwise */

export interface CardSong {
  /** "Side A" title — the headline name. */
  titleA: string;
  /** "Side B" title — printed as the secondary track in many layouts. */
  titleB: string;
  /** Artist name. */
  artist: string;
  /** Short slot code, e.g. "A1", "K12". */
  code: string;
  /** Optional source marker drawn as a colored stripe along the left edge. */
  source?: 'now' | 'queue' | 'playlist';
}

export interface CardArt {
  /** 256×100 canvas with the rendered card. */
  canvas: HTMLCanvasElement;
  /** Primary accent color (palette[2]). */
  accent: string;
  /** Card background color (palette[0]). */
  bg: string;
  /** Alternate accent color (palette[3]). */
  alt: string;
}

/** Mulberry-style 32-bit string-seeded hash; returns a uint32 stream. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0);
  };
}

/** Pick #000 or #fff for max contrast against a #rrggbb background. */
export function getContrast(hex: string): string {
  if (!hex || hex[0] !== '#') return '#000000';
  const r = parseInt(hex.substr(1, 2), 16);
  const g = parseInt(hex.substr(3, 2), 16);
  const b = parseInt(hex.substr(5, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#ffffff';
}

/**
 * 35 four-color palettes. Mutate at runtime to skin the output (e.g. push
 * monochrome rows for a black-and-white print run).
 */
export const palettes: string[][] = [
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

/** Heavy display faces — used for headline titles. */
export const displayFonts: string[] = ["'Anton'", "'Bebas Neue'", "'Monoton'", "'Righteous'", "'Fjalla One'", "'Limelight'", "'Rampart One'", "'Rubik Mono One'", "'Abril Fatface'", "'Bungee'", "'Bangers'"];
/** Script faces — used for "by The Artist" lines. */
export const scriptFonts: string[] = ["'Pacifico'", "'Lobster'", "'Yellowtail'", "'Satisfy'", "'Shrikhand'", "'Permanent Marker'", "'Fascinate'"];
/** Monospaced-feel faces — used for the short slot code. */
export const codeFonts: string[] = ["'Rubik Mono One'", "'Courier Prime'", "'Oswald'"];
/** Body / info faces — used for fine print and album credits. */
export const infoFonts: string[] = ["'Courier Prime'", "'Oswald'", "'Cinzel'", "'Playfair Display'", "'Poiret One'", "'Arimo'"];

/**
 * Explicitly load every font this module renders into canvas.
 *
 * Why this exists: `document.fonts.ready` only waits for fonts referenced by
 * elements actually on the page (CSS rules, rendered text). All of the faces
 * above are used exclusively via the canvas 2D API — which DOES NOT trigger
 * the browser to start downloading the underlying woff2 file. On mobile,
 * Safari/Chrome preload all @font-face from a loaded stylesheet, so the cards
 * happen to look right. On desktop, both browsers wait until something
 * references the font in DOM/CSS, so canvas draws fall back to the default
 * serif/sans before our preload await ever resolves.
 *
 * Calling `document.fonts.load("16px 'Oswald'")` for each face explicitly
 * tells the FontFaceSet to fetch the file. Await all of them and the next
 * `ctx.fillText(...)` will hit the real glyphs.
 */
export async function preloadCardFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const families = new Set<string>();
  for (const list of [displayFonts, scriptFonts, codeFonts, infoFonts]) {
    for (const f of list) families.add(f);
  }
  // Category labels render bold 28px Oswald — request both weights so the
  // load includes the bold woff2 (Oswald is published at 500 + 700 in our
  // layout.tsx <link>).
  await Promise.all(
    [...families].flatMap((f) => [
      document.fonts.load(`16px ${f}`).catch(() => undefined),
      document.fonts.load(`bold 16px ${f}`).catch(() => undefined),
    ]),
  );
}

/**
 * Render a procedurally-laid-out jukebox card for `song`.
 *
 * 256×100 canvas. The same `song` always produces the same card (seeded by
 * `titleA + artist + code`). 30 backgrounds × 30 decor patterns × 9 borders ×
 * 30 layouts = 243 000 combinations, plus random font + palette per draw.
 */
export function generateCardArt(song: CardSong): CardArt {
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
  const fCode = codeFonts[rndInt(codeFonts.length)];
  const fInfo = infoFonts[rndInt(infoFonts.length)];

  const pal = palettes[rndInt(palettes.length)];
  const bg1 = pal[0]; const bg2 = pal[1]; const acc1 = pal[2]; const acc2 = pal[3];
  const tc1 = getContrast(bg1);

  const drawAdvText = (text: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign, scaleX = 1, scaleY = 1, rot = 0, shadow = false) => {
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
    else if (type === 8) { ctx.moveTo(cx, cy - size / 2); ctx.bezierCurveTo(cx + size / 3, cy - size / 2, cx + size / 2, cy - size / 4, cx + size / 2, cy); ctx.lineTo(cx + size / 2.5, cy + size / 6); ctx.lineTo(cx + size / 2, cy + size / 3); ctx.lineTo(cx + size / 2, cy + size / 2); ctx.lineTo(cx - size / 2, cy + size / 2); ctx.lineTo(cx - size / 2, cy - size / 2); }
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
  else if (decorStyle === 2) { ctx.globalAlpha = 0.15; drawAdvText(song.code, 128, 50, `bold 90px ${fCode}`, tc1, 'center'); ctx.globalAlpha = 1.0; }
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
  const boxCode = (bx: number, by: number, bw: number, bh: number) => { ctx.fillStyle = aTxt; ctx.fillRect(bx, by, bw, bh); drawAdvText(cd, bx + bw / 2, by + bh / 2, `bold 14px ${fCode}`, getContrast(aTxt), 'center'); };

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
  else if (layoutStyle === 13) { ctx.fillStyle = aTxt; ctx.beginPath(); ctx.moveTo(200, 0); ctx.lineTo(256, 0); ctx.lineTo(256, 56); ctx.fill(); ctx.save(); ctx.translate(235, 20); ctx.rotate(Math.PI / 4); drawAdvText(cd, 0, 0, `bold 12px ${fCode}`, getContrast(aTxt), 'center'); ctx.restore(); drawAdvText(tA, 110, 40, '24px ' + fScrpt, mTxt, 'center'); drawAdvText(art, 110, 70, '14px ' + fInfo, mTxt, 'center'); }
  else if (layoutStyle === 14) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 128, 100); ctx.fillStyle = '#eee'; ctx.fillRect(128, 0, 128, 100); drawAdvText(tA, 64, 40, '20px ' + fDisp, '#eee', 'center'); drawAdvText(tB, 192, 40, '20px ' + fDisp, '#111', 'center'); ctx.fillStyle = acc1; ctx.fillRect(80, 75, 96, 25); drawAdvText(art, 128, 87, '14px ' + fInfo, getContrast(acc1), 'center'); drawAdvText(cd, 15, 15, `bold 12px ${fCode}`, '#eee', 'left'); }
  else if (layoutStyle === 15) { drawAdvText(tA, 128, 40, '40px ' + fDisp, mTxt, 'center', 1, 1.4); drawAdvText(art + ' • ' + cd, 240, 85, '12px ' + fInfo, aTxt, 'right'); }
  else if (layoutStyle === 16) { ctx.fillStyle = aTxt; ctx.fillRect(0, 0, 60, 100); drawAdvText(cd, 30, 50, 'bold 20px ' + fInfo, getContrast(aTxt), 'center'); drawAdvText(tA, 70, 30, '22px ' + fDisp, mTxt, 'left'); drawAdvText(art, 70, 60, '16px ' + fScrpt, aTxt, 'left'); drawAdvText(tB, 70, 85, '14px ' + fDisp, mTxt, 'left'); }
  else if (layoutStyle === 17) { drawAdvText(tA, 130, 42, '28px ' + fDisp, '#000000', 'center', 1, 1); drawAdvText(tA, 128, 40, '28px ' + fDisp, mTxt, 'center', 1, 1); drawAdvText('BY ' + art, 128, 75, '16px ' + fInfo, aTxt, 'center'); boxCode(10, 10, 35, 20); }
  else if (layoutStyle === 18) { drawAdvText(art, 128, 20, '14px ' + fInfo, aTxt, 'center'); ctx.fillStyle = mTxt; ctx.fillRect(20, 35, 216, 35); drawAdvText(tA, 128, 53, '24px ' + fDisp, getContrast(mTxt), 'center'); drawAdvText(tB, 128, 85, '14px ' + fScrpt, mTxt, 'center'); }
  else if (layoutStyle === 19) { drawAdvText(tA.charAt(0), 40, 50, '60px ' + fDisp, aTxt, 'center'); drawAdvText(tA.slice(1), 75, 40, '24px ' + fDisp, mTxt, 'left'); drawAdvText(art, 75, 70, '18px ' + fScrpt, mTxt, 'left'); drawAdvText(cd, 240, 20, `12px ${fCode}`, aTxt, 'right'); }
  else if (layoutStyle === 20) { boxCode(10, 10, 35, 20); drawAdvText(tA, 240, 40, '24px ' + fDisp, mTxt, 'right', 1, 1.2); drawAdvText(art, 240, 75, '16px ' + fScrpt, aTxt, 'right'); }
  else if (layoutStyle === 21) { drawAdvText(tA.split(' ')[0], 40, 35, '26px ' + fDisp, mTxt, 'left'); drawAdvText(tA.split(' ').slice(1).join(' ') || 'HIT', 216, 65, '26px ' + fDisp, mTxt, 'right'); drawAdvText(cd + ' • ' + art, 128, 50, '12px ' + fInfo, aTxt, 'center'); }
  else if (layoutStyle === 22) { drawAdvText(art + ' [' + cd + ']', 128, 25, '14px ' + fInfo, aTxt, 'center'); drawAdvText(tA, 128, 65, '36px ' + fDisp, mTxt, 'center', 1, 1.5); }
  else if (layoutStyle === 23) { ctx.strokeStyle = mTxt; ctx.lineWidth = 1.5; ctx.font = '30px ' + fDisp; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.strokeText(tA, 128, 40, 240); drawAdvText(art, 128, 75, '16px ' + fScrpt, aTxt, 'center'); drawAdvText(cd, 20, 20, `12px ${fCode}`, mTxt, 'center'); }
  else if (layoutStyle === 24) { drawAdvText(tA, 128, 35, '28px ' + fDisp, mTxt, 'center', 1.2, 1); ctx.fillStyle = aTxt; ctx.fillRect(64, 65, 128, 20); drawAdvText(art, 128, 75, '14px ' + fInfo, getContrast(aTxt), 'center'); boxCode(210, 70, 35, 20); }
  else if (layoutStyle === 25) { drawAdvText(art, 128, 20, '14px ' + fInfo, aTxt, 'center'); drawAdvText(tA, 128, 60, '40px ' + fDisp, mTxt, 'center', 1, 1.2); drawAdvText(cd, 25, 85, `12px ${fCode}`, mTxt, 'left'); }
  else if (layoutStyle === 26) { drawAdvText(cd, 25, 50, 'bold 16px ' + fInfo, getContrast(bgStyle === 25 ? bg2 : bg1), 'center', 1, 1, -Math.PI / 2); drawAdvText(tA, 150, 35, '26px ' + fDisp, mTxt, 'center'); drawAdvText(art, 150, 70, '16px ' + fScrpt, aTxt, 'center'); }
  else if (layoutStyle === 27) { drawAdvText(tA, 128, 25, '18px ' + fDisp, mTxt, 'center'); drawAdvText(tB, 128, 50, '18px ' + fDisp, mTxt, 'center'); drawAdvText(art, 128, 75, '18px ' + fScrpt, aTxt, 'center'); }
  else if (layoutStyle === 28) { drawAdvText(art, 128, 25, '16px ' + fScrpt, aTxt, 'center'); drawAdvText(tA, 128, 70, '36px ' + fDisp, mTxt, 'center', 1.2, 1); }
  else if (layoutStyle === 29) { ctx.fillStyle = aTxt; ctx.beginPath(); ctx.moveTo(40, 40); ctx.lineTo(216, 40); ctx.arc(216, 50, 10, -Math.PI / 2, Math.PI / 2); ctx.lineTo(40, 60); ctx.arc(40, 50, 10, Math.PI / 2, -Math.PI / 2); ctx.fill(); drawAdvText(tA, 128, 50, '18px ' + fDisp, getContrast(aTxt), 'center'); drawAdvText(art, 128, 80, '14px ' + fInfo, mTxt, 'center'); drawAdvText(cd, 128, 20, `14px ${fCode}`, mTxt, 'center'); }

  // Source stripe (left edge): green = now playing, amber = in queue, none for normal deck.
  const srcColor = song.source === 'now' ? '#00ff88' : song.source === 'queue' ? '#ffaa00' : null;
  if (srcColor) { ctx.fillStyle = srcColor; ctx.fillRect(0, 0, 4, 100); }

  // Paper-grain noise overlay
  for (let i = 0; i < 1500; i++) {
    ctx.fillStyle = (i % 2 === 0) ? '#000000' : '#ffffff';
    ctx.globalAlpha = rnd() * 0.04;
    ctx.fillRect(rndInt(256), rndInt(100), 1.5, 1.5);
  }
  ctx.globalAlpha = 1.0;

  return { canvas, accent: acc1, bg: bg1, alt: acc2 };
}
