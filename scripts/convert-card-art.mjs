#!/usr/bin/env node
/**
 * Converts lib/card-art.ts → packages/juke-cards/src/*.tish
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'lib/card-art.ts'), 'utf8');
const outDir = path.join(root, 'packages/juke-cards/src');

function stripTypes(code) {
  return code
    .replace(/^\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/export interface [\s\S]*?\n}\n/g, '')
    .replace(/: CardSong|: CardArt|: string|: number|: boolean|: Promise<void>|: CanvasRenderingContext2D|: CanvasTextAlign|: string\[\]\[\]/g, '')
    .replace(/\([^)]*\): [^{;=]+(?=[{;=])/g, (m) => m.replace(/: [^{;=]+$/, ''))
    .replace(/ as any/g, '')
    .replace(/\)!/g, ')')
    .replace(/getContext\('2d', \{ willReadFrequently: true \}\)!/g, "getContext('2d', { willReadFrequently: true })")
    .replace(/export function /g, 'export fn ')
    .replace(/export async function /g, 'export async fn ')
    .replace(/function getWcagLuminance\(r, g, b\)/g, 'fn getWcagLuminance(r, g, b)')
    .replace(/\(max: number\)/g, '(max)')
    .replace(/\(str: string\)/g, '(str)')
    .replace(/\(hex: string\)/g, '(hex)')
    .replace(/\(song: CardSong\)/g, '(song)')
    .replace(/\(targetCtx[^)]*\)/g, '(targetCtx, text, x, y, font, color, align, scaleX, scaleY, rot, shadowOverride)')
    .replace(/\(type: number[^)]*\)/g, '(type, cx, cy, size, color)')
    .replace(/\(bx: number[^)]*\)/g, '(bx, by, bw, bh)')
    .replace(/\(i: number\)/g, '(i)')
    .replace(/\(v: number\)/g, '(v)')
    .replace(/\(r: number, g: number, b: number\)/g, '(r, g, b)')
    .replace(/const /g, 'let ')
    .replace(/let rnd = \(\) => \(seedGen\(\) >>> 0\) \/ 4294967296/g, 'let rnd = () => (seedGen() % 4294967296) / 4294967296')
    .replace(/\(h << 13\) \| \(h >>> 19\)/g, '((h * 8192) | Math.floor(h / 524288))')
    .replace(/h \^ \(h >>> 16\)/g, 'h ^ Math.floor(h / 65536)')
    .replace(/h \^ \(h >>> 13\)/g, 'h ^ Math.floor(h / 8192)')
    .replace(/\(\(h \^= h >>> 16\) >>> 0\)/g, '(h ^ Math.floor(h / 65536)) % 4294967296')
    .replace(/\.substr\(/g, '.substring(')
    .replace(/for \(let /g, 'for (let ')
    .replace(/new Set\(\[([^\]]+)\]\)/g, '[$1]')
    .replace(/(\w+)\.has\((\w+)\)/g, 'arrayIncludes($1, $2)');
}

const helpers = `fn arrayIncludes(arr, val) {
  let i = 0
  while (i < arr.length) {
    if (arr[i] === val) { return true }
    i = i + 1
  }
  return false
}

`;

let body = stripTypes(src);

// xmur3 + getContrast
const xmur3Match = body.match(/export fn xmur3[\s\S]*?export fn getContrast[\s\S]*?return \(r \* 299[\s\S]*?\n}/);
const xmur3 = xmur3Match ? xmur3Match[0].replace(/export fn getContrast[\s\S]*/, '') : '';
const contrastMatch = body.match(/export fn getContrast[\s\S]*?return \(r \* 299[\s\S]*?\n}/);
const getContrast = contrastMatch ? contrastMatch[0] : '';

// palettes section
const palettesMatch = body.match(/export const palettes[\s\S]*?export const infoFonts[\s\S]*?\];/);
const palettesBlock = palettesMatch ? palettesMatch[0] : '';

const preloadMatch = body.match(/export async fn preloadCardFonts[\s\S]*?^\}/m);
const preloadBlock = preloadMatch ? preloadMatch[0] : '';

// getWcagLuminance + generateCardArt
const wcagMatch = body.match(/fn getWcagLuminance[\s\S]*?return a\[0\] \* 0\.2126[\s\S]*?\n}/);
const wcagBlock = wcagMatch ? wcagMatch[0] : '';

const genMatch = body.match(/export fn generateCardArt[\s\S]*?return \{ canvas, accent: acc1, bg: bg1, alt: acc2 \};\n}/);
const genBlock = genMatch ? genMatch[0] : '';

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'xmur3.tish'),
  `${helpers}${xmur3.trim()}\n\n${getContrast.trim()}\n`,
);

fs.writeFileSync(
  path.join(outDir, 'palettes.tish'),
  `${palettesBlock.trim()}\n\n${preloadBlock.trim()}\n`,
);

// Split generate into layer files (backgrounds = LAYER 1 section inside generate)
fs.writeFileSync(
  path.join(outDir, 'backgrounds.tish'),
  `// Background layer styles (bgStyle 0–45) — invoked from generate.tish\nexport fn backgroundsPlaceholder() { return null }\n`,
);

fs.writeFileSync(
  path.join(outDir, 'decor.tish'),
  `// Decor layer styles — invoked from generate.tish\nexport fn decorPlaceholder() { return null }\n`,
);

fs.writeFileSync(
  path.join(outDir, 'borders.tish'),
  `// Border layer styles — invoked from generate.tish\nexport fn bordersPlaceholder() { return null }\n`,
);

fs.writeFileSync(
  path.join(outDir, 'layouts.tish'),
  `// Layout / typography styles — invoked from generate.tish\nexport fn layoutsPlaceholder() { return null }\n`,
);

fs.writeFileSync(
  path.join(outDir, 'generate.tish'),
  `import { xmur3, getContrast } from "./xmur3.tish"
import { palettes, displayFonts, scriptFonts, codeFonts, infoFonts } from "./palettes.tish"

${wcagBlock.trim()}

${genBlock.trim()}
`,
);

fs.writeFileSync(
  path.join(outDir, 'index.tish'),
  `import { xmur3, getContrast } from "./xmur3.tish"
import { palettes, displayFonts, scriptFonts, codeFonts, infoFonts, preloadCardFonts } from "./palettes.tish"
import { generateCardArt } from "./generate.tish"

export { xmur3, getContrast, palettes, displayFonts, scriptFonts, codeFonts, infoFonts, preloadCardFonts, generateCardArt }
`,
);

console.log('Wrote juke-cards Tish sources to', outDir);
