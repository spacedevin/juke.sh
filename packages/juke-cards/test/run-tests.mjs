#!/usr/bin/env node
/**
 * Smoke + deterministic regression tests for @spacedevin/juke-cards.
 * Runs in Node with jsdom-like minimal DOM stubs for canvas.
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Minimal canvas stub
class CanvasStub {
  constructor() {
    this.width = 0
    this.height = 0
    this._ctx = new CtxStub(this)
  }
  getContext() { return this._ctx }
}
class CtxStub {
  constructor(canvas) { this.canvas = canvas }
  save() {}
  restore() {}
  fillRect() {}
  fillText() {}
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
  scale() {}
  stroke() {}
  fill() {}
  setLineDash() {}
  drawImage() {}
  getImageData() {
    const n = this.canvas.width * this.canvas.height * 4
    return { data: new Uint8ClampedArray(n), width: this.canvas.width, height: this.canvas.height }
  }
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  }
  putImageData() {}
}

globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") return new CanvasStub()
    return {}
  },
  fonts: { load: async () => {}, ready: Promise.resolve() },
}

const mod = await import(path.join(root, "lib/index.mjs"))

assert.equal(typeof mod.xmur3, "function")
assert.equal(typeof mod.generateCardArt, "function")

const g1 = mod.xmur3("seed")
const g2 = mod.xmur3("seed")
assert.equal(g1(), g2())
assert.notEqual(g1(), mod.xmur3("other")())

const song = { titleA: "JOHNNY B", titleB: "GOODE", artist: "Chuck Berry", code: "A1" }
const a = mod.generateCardArt(song)
const b = mod.generateCardArt(song)
assert.equal(a.accent, b.accent)
assert.equal(a.bg, b.bg)
assert.equal(a.canvas.width, 256)
assert.equal(a.canvas.height, 100)

const c = mod.generateCardArt({ ...song, code: "A2" })
assert.notEqual(a.accent, c.accent)

console.log("juke-cards tests passed")
