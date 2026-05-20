# juke.sh/BOX

![Loaded jukebox](docs/screenshots/demo.gif)

3D Spotify jukebox modeled after a chrome-and-neon 50s diner record machine. Three.js scene, full procedural card art ([`@spacedevin/juke-cards`](packages/juke-cards)), real Spotify integration — your playlists become the records on the drum.

Built as a **Tish + Lattish** static SPA (no Next.js server). Uses PKCE auth — each user authenticates with their own Spotify account and all API calls go directly from their browser to Spotify.

## Monorepo

```
packages/
  juke-cards/   @spacedevin/juke-cards — procedural canvas card art (npm)
  jukebox/      Lattish SPA served from public/
  bridges/      Three.js + Tone.js vendor bundle (JS shim)
```

## Setup

1. Create an app at https://developer.spotify.com/dashboard
2. Add redirect URIs:
   - `https://juke.sh/callback`
   - `http://127.0.0.1:3000/callback` (local dev)
3. `npm install`
4. Copy `.env.local.example` to `.env.local` and set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID`
5. `just dev` — serves on http://127.0.0.1:3000
6. Visit `/` → **LOGIN WITH SPOTIFY** (Client ID is pre-filled from `.env.local`)
7. On `/box`, pick playlists to load into the deck

No client secret needed — PKCE auth is browser-only. The Client ID is public and is baked into `public/dist/config.js` at build time (same as the old `NEXT_PUBLIC_` Next.js flow).

For production (Vercel, etc.), set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` or `SPOTIFY_CLIENT_ID` in the host's environment variables at build time. You can still paste a Client ID on `/` instead — it is stored in `localStorage` and overrides the baked default.

Playback requires an active Spotify device (desktop app, phone, web player, etc.).

## Commands

| Command | Description |
|---------|-------------|
| `just dev` | Build + Tish dev server (`:3000`, SPA fallback) |
| `just build` | Cards + vendor + Lattish bundles → `packages/jukebox/public/dist/` |
| `just test` | juke-cards smoke tests |
| `just fmt` / `just lint` | Tish format/lint (requires `TISH_ROOT` cargo binaries) |

See [docs/TISH_TOOLING.md](docs/TISH_TOOLING.md) for compiler install and CI notes.

## Local development

From the repo root:

```bash
npm install
cp .env.local.example .env.local   # add your Spotify Client ID
just dev    # http://127.0.0.1:3000 — register this callback URL in Spotify
```

To test on a phone over the network, use a tunnel (e.g. `ngrok http 3000`) and add `https://YOUR-TUNNEL/callback` to your Spotify app's redirect URIs. The dev server logs OAuth hits on `/callback`.

## Routes

- `/` — landing (Client ID + login)
- `/box` — jukebox app
- `/dev` — procedural debug tracks (no Spotify)
- `/callback` — OAuth redirect
- `/logout` — clear session

Arrow keys: spin (←/→), rows (↑/↓). `C` category labels, `M` audio, `S` shuffle, `Z`/`X` zoom tight, `V` telephoto flatness.

## Deploy (Vercel)

This is a **static SPA**, not Next.js. In the Vercel project settings:

1. **Root Directory:** leave empty (repo root) — or set `packages/jukebox` if you prefer; both `vercel.json` files are configured for monorepo builds.
2. **Framework Preset:** **Other** (not Next.js). The repo sets `"framework": null` in `vercel.json` to skip framework detection.
3. **Environment variables:** `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` or `SPOTIFY_CLIENT_ID` (build time → `public/dist/config.js`).

Build runs `npm run vercel-build` from the monorepo root (installs workspaces, compiles Tish, writes static files to `packages/jukebox/public/`).

## Card art package

Procedural 256×100 slot cards live in [`@spacedevin/juke-cards`](packages/juke-cards). Demo grid: `packages/juke-cards/demo/index.html` (after `npm run build --workspace=@spacedevin/juke-cards`).

## License

PIF
