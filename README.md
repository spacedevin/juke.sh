# Jukebox

3D Spotify jukebox. Uses PKCE auth — each user authenticates with their own Spotify account and all API calls go directly from their browser to Spotify (no shared rate limit on a server proxy).

## Setup

1. Create an app at https://developer.spotify.com/dashboard
2. Add redirect URI: `https://YOUR_HOST/callback` (and `http://127.0.0.1:3000/callback` for local dev)
3. Copy `.env.local.example` to `.env.local`, fill in `NEXT_PUBLIC_SPOTIFY_CLIENT_ID`
4. Add Spotify playlist IDs to `lib/playlists.ts`
5. `npm install && npm run dev`

Playback requires an active Spotify device (open Spotify somewhere on your account).

## Notes

- No client secret needed — PKCE auth is browser-only.
- Tokens stored in `localStorage`; refresh handled automatically.
- The `NEXT_PUBLIC_` prefix on the client ID means it ships in the JS bundle, which is fine — Spotify client IDs are public.
