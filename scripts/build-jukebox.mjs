#!/usr/bin/env node
import { cp, mkdir, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadRepoEnv, resolveSpotifyClientId } from "./load-env.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const jukebox = path.join(root, "packages/jukebox")
const dist = path.join(jukebox, "public/dist")
const tish =
  process.env.TISH ||
  path.join(root, "node_modules", ".bin", "tish")

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

await mkdir(dist, { recursive: true })

run("npm", ["run", "build", "--workspace=@spacedevin/juke-cards"], root)
run("npm", ["run", "build", "--prefix", path.join(root, "packages/bridges")], root)

await cp(path.join(root, "packages/bridges/dist/vendor.js"), path.join(dist, "vendor.js"))
await cp(path.join(root, "packages/juke-cards/dist/index.js"), path.join(dist, "juke-cards.js"))

run(tish, ["build", "--target", "js", "src/main.tish", "-o", "public/dist/jukebox.js"], jukebox)

const clientId = resolveSpotifyClientId(loadRepoEnv(root))
const configJs =
  "window.__JUKE_CONFIG=window.__JUKE_CONFIG||{};\n" +
  `window.__JUKE_CONFIG.spotifyClientId=${JSON.stringify(clientId)};\n`
await writeFile(path.join(dist, "config.js"), configJs)

console.log("jukebox build complete")
if (clientId) {
  console.log("Spotify Client ID loaded from env → public/dist/config.js")
}
