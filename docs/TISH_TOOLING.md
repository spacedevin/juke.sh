# Tish tooling (juke.sh monorepo)

This repo uses the [Tish](https://tishlang.com) compiler and Lattish JSX runtime. Local development follows patterns from [tishlang/learn](https://github.com/tishlang/learn).

## Install

```bash
npm install
# Tish CLI via npm (@tishlang/tish) or cargo install from ~/Projects/tish
```

Pin versions: `@tishlang/tish@^1.10.0`, `lattish@^1.1.3` (npm alias `@tishlang/lattish`).

## Commands (justfile)

| Target | Description |
|--------|-------------|
| `just build` | Build cards + vendor + Lattish SPA bundles |
| `just dev` | Build then serve on `:3000` (Spotify callback URL) |
| `just fmt` / `just fmt-check` | Format Tish sources (`tish-fmt` from `TISH_ROOT`) |
| `just lint` | Lint Tish sources (`tish-lint`) |
| `just test` | Run juke-cards smoke tests |

### Environment

- `TISH_ROOT` — path to tish cargo repo (default `../tish`). Used for `tish-fmt` / `tish-lint` binaries.
- `TISH` — tish CLI override (default `tish`)
- `PORT` — dev server port (default `3000`)

If npm `@tishlang/tish` lacks `fs`/`http`/`process` features, build from source:

```bash
cd "$TISH_ROOT" && cargo install --path crates/tish
```

## Remote / tunnel dev

The Tish dev server binds to port **3000** by default (`PORT` override supported). For OAuth on a non-localhost device:

1. Run `just dev` locally.
2. Tunnel port 3000 (ngrok, Cloudflare Tunnel, etc.).
3. Add `https://YOUR-TUNNEL-HOST/callback` to your Spotify app redirect URIs.
4. Open the tunnel URL on your device.

The dev server logs `/callback` requests to help debug PKCE round-trips.

## Package layout

- `packages/juke-cards` — `@spacedevin/juke-cards` npm library (Tish → JS)
- `packages/jukebox` — Lattish SPA (`tish build --target js`, no Node server in prod)
- `packages/bridges` — Three.js + Tone.js vendor bundle (plain JS, out of tish-lint scope)

## Official docs

- [Tish language](https://tishlang.com/docs)
- [Modules](https://tishlang.com/docs/language/modules)
- [Lattish](https://lattish.com/docs)

## Upstream note

`tish-fmt` and `tish-lint` are not yet published as standalone npm packages; this repo invokes cargo-built binaries from `TISH_ROOT`. Consider upstream packaging if CI without Rust becomes a requirement.
