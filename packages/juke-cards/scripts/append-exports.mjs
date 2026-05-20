import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, "dist", "index.js")
const lib = path.join(root, "lib", "index.mjs")
const nativePath = path.join(root, "scripts", "xmur3-native.js")

fs.mkdirSync(path.dirname(lib), { recursive: true })
let js = fs.readFileSync(dist, "utf8")

// Tish cannot compile >>>; replace xmur3/getContrast with the exact TS port.
const native = fs.readFileSync(nativePath, "utf8").replace(/^export /gm, "")
js = js.replace(/^function xmur3[\s\S]*?\nconst palettes/m, `${native.trim()}\nconst palettes`)

// Unsigned rng stream for style picks (matches card-art.ts).
js = js.replace(
  "let rnd = () => ((((seedGen() ?? null) % 4294967296) / 4294967296));",
  "let rnd = () => ((seedGen() >>> 0) / 4294967296);",
)

if (!js.includes("export { xmur3")) {
  js += "\nexport { xmur3, getContrast, generateCardArt, preloadCardFonts, palettes, displayFonts, scriptFonts, codeFonts, infoFonts };\n"
}
fs.writeFileSync(dist, js)
fs.copyFileSync(dist, lib)
