#!/usr/bin/env node
/**
 * Compare built @spacedevin/juke-cards output against lib/card-art.ts reference.
 * Run from repo root: node packages/juke-cards/scripts/compare-ts-tish.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repo = path.dirname(path.dirname(root))
const tsPath = path.join(repo, ".compare-card-art.ts")

// Minimal canvas for Node
class Ctx {
  constructor(w, h) {
    this.canvas = { width: w, height: h }
    this._w = w
    this._h = h
    this._pixels = new Uint8ClampedArray(w * h * 4)
    this.fillStyle = "#000"
    this.strokeStyle = "#000"
    this.font = "16px sans-serif"
    this.globalAlpha = 1
    this.globalCompositeOperation = "source-over"
    this.textAlign = "left"
    this.textBaseline = "alphabetic"
    this.lineWidth = 1
    this.shadowColor = "transparent"
    this.shadowOffsetX = 0
    this.shadowOffsetY = 0
    this.shadowBlur = 0
    this._stack = []
  }
  save() { this._stack.push(this._snap()) }
  restore() { Object.assign(this, this._stack.pop()) }
  _snap() {
    return {
      fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha,
      textAlign: this.textAlign, textBaseline: this.textBaseline,
      shadowColor: this.shadowColor, shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY, shadowBlur: this.shadowBlur,
    }
  }
  fillRect(x, y, w, h) { /* stub */ }
  strokeRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  translate() {}
  rotate() {}
  scale(sx, sy) { this._sx = sx; this._sy = sy }
  stroke() {}
  fill() {}
  setLineDash() {}
  drawImage(src) {
    if (src?._pixels) this._pixels.set(src._pixels)
  }
  fillText(text, x, y, maxWidth) {
    // Record text draws for drawAdvText default-parameter regression
    if (!this._textOps) this._textOps = []
    this._textOps.push({ text, maxWidth })
  }
  strokeText(text, x, y, maxWidth) {
    if (!this._textOps) this._textOps = []
    this._textOps.push({ text, maxWidth, stroke: true })
  }
  getImageData(x, y, w, h) {
    return { data: this._pixels.slice(), width: w, height: h }
  }
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  }
  putImageData(img) { this._pixels.set(img.data) }
}
class Canvas {
  constructor() { this.width = 0; this.height = 0; this._ctx = null }
  getContext() {
    if (!this._ctx) this._ctx = new Ctx(this.width, this.height)
    this._ctx.canvas = this
    return this._ctx
  }
}
globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return new Canvas()
    return {}
  },
  fonts: { load: async () => {}, ready: Promise.resolve() },
}

// Reference xmur3/getContrast from card-art.ts
function xmur3Ref(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^ (h >>> 16)) >>> 0
  }
}

function xmur3TishBroken(str) {
  let h = 1779033703 ^ str.length
  let i = 0
  while (i < str.length) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h * 8192) | Math.floor(h / 524288)
    i++
  }
  return () => {
    h = Math.imul(h ^ Math.floor(h / 65536), 2246822507)
    h = Math.imul(h ^ Math.floor(h / 8192), 3266489909)
    h = h ^ Math.floor(h / 65536)
    return h % 4294967296
  }
}

const mod = await import(path.join(root, "lib/index.mjs"))

const songs = [
  { titleA: "JOHNNY B", titleB: "GOODE", artist: "Chuck Berry", code: "A1" },
  { titleA: "ROCK AROUND", titleB: "THE CLOCK", artist: "Bill Haley", code: "K12" },
  { titleA: "Blue Shoes", titleB: "Crazy Love", artist: "Elvis Presley", code: "B3" },
  { titleA: "OPEN", titleB: "SLOT", artist: "QUEUE", code: "C4" },
]

console.log("=== xmur3 stream (first 8 values per song) ===")
for (const song of songs) {
  const seed = song.titleA + song.artist + song.code
  const ref = xmur3Ref(seed)
  const built = mod.xmur3(seed)
  const tishBroken = xmur3TishBroken(seed)
  const refVals = Array.from({ length: 8 }, () => ref())
  const builtVals = Array.from({ length: 8 }, () => built())
  const brokenVals = Array.from({ length: 8 }, () => tishBroken())
  const matchBuilt = refVals.every((v, i) => v === builtVals[i])
  const matchBroken = refVals.every((v, i) => v === brokenVals[i])
  console.log(`  ${song.code}: built matches TS ref = ${matchBuilt}, tish-source broken matches = ${matchBroken}`)
}

console.log("\n=== Style picks (first 4 rndInt calls = bg, decor, border, layout) ===")
function stylePicks(xmur3Fn, seed) {
  const g = xmur3Fn(seed)
  const rnd = () => (g() >>> 0) / 4294967296
  const ri = (m) => Math.floor(rnd() * m)
  return [ri(46), ri(46), ri(15), ri(47)]
}
for (const song of songs) {
  const seed = song.titleA + song.artist + song.code
  const ref = stylePicks(xmur3Ref, seed)
  const built = stylePicks(mod.xmur3, seed)
  const broken = stylePicks(xmur3TishBroken, seed)
  console.log(`  ${song.code}: ref=${JSON.stringify(ref)} built=${JSON.stringify(built)} broken=${JSON.stringify(broken)}`)
}

console.log("\n=== drawAdvText defaults (7-arg calls) ===")
let nanMaxWidth = 0
let missingShadow = 0
for (let i = 0; i < 50; i++) {
  const song = { ...songs[i % songs.length], code: "T" + i }
  const { canvas } = mod.generateCardArt(song)
  const ops = canvas.getContext("2d")._textOps || []
  for (const op of ops) {
    if (Number.isNaN(op.maxWidth)) nanMaxWidth++
  }
}
console.log(`  NaN maxWidth fillText calls: ${nanMaxWidth} (expect 0)`)
console.log(`  Built source has conditional useTextShadows: ${fs.readFileSync(path.join(root, "src/generate.tish"), "utf8").includes("useTextShadows = !isSolidFlatCard")}`)
console.log(`  Built source has shadowOverride default: ${fs.readFileSync(path.join(root, "src/generate.tish"), "utf8").includes('typeof shadowOverride !== "number"')}`)

console.log("\n=== Determinism (same song → same colors) ===")
const s = songs[0]
const a = mod.generateCardArt(s)
const b = mod.generateCardArt(s)
console.log(`  accent match: ${a.accent === b.accent}, bg match: ${a.bg === b.bg}`)

console.log("\n=== API surface ===")
const exports = ["xmur3", "getContrast", "generateCardArt", "preloadCardFonts", "palettes", "displayFonts", "scriptFonts", "codeFonts", "infoFonts"]
for (const e of exports) {
  console.log(`  ${e}: ${typeof mod[e]}`)
}
