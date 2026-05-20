import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const out = {}
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** Load repo-root .env then .env.local; process.env wins on key conflicts. */
export function loadRepoEnv(root) {
  const fileEnv = {
    ...parseEnvFile(path.join(root, ".env")),
    ...parseEnvFile(path.join(root, ".env.local")),
  }
  return { ...fileEnv, ...process.env }
}

export function resolveSpotifyClientId(env) {
  const id = env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || env.SPOTIFY_CLIENT_ID || ""
  return String(id).trim()
}
