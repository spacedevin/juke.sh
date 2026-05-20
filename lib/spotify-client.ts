// Browser-only Spotify PKCE client.
// Tokens live in localStorage; no server proxy.

// Client ID resolution: user-supplied (localStorage) takes precedence over the
// env-baked default. Lets people drop in their own Spotify app without
// redeploying.
const CLIENT_ID_KEY = 'sp_client_id';
function clientId(): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
  }
  return process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || '';
}
export function getStoredClientId(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}
export function setStoredClientId(id: string) {
  const v = (id || '').trim();
  if (v) localStorage.setItem(CLIENT_ID_KEY, v);
  else localStorage.removeItem(CLIENT_ID_KEY);
}
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

const LS_ACCESS = 'sp_access';
const LS_REFRESH = 'sp_refresh';
const LS_EXPIRES = 'sp_expires';
const SS_VERIFIER = 'sp_verifier';
const SS_STATE = 'sp_state';

function redirectUri() {
  return `${window.location.origin}/callback`;
}

function b64url(bytes: Uint8Array) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier(len = 64) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

async function challenge(verifier: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

export async function login() {
  // PKCE: verifier + code_challenge protects the code exchange.
  // state: random nonce stored in sessionStorage, echoed back by Spotify on
  // the redirect; verified in /callback. Closes the CSRF window that PKCE
  // alone doesn't cover (the flow *initiation*).
  const verifier = randomVerifier();
  const state = randomVerifier(16);
  sessionStorage.setItem(SS_VERIFIER, verifier);
  sessionStorage.setItem(SS_STATE, state);
  const code_challenge = await challenge(verifier);
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge,
    state,
    scope: SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export function consumeState(): string | null {
  const s = sessionStorage.getItem(SS_STATE);
  sessionStorage.removeItem(SS_STATE);
  return s;
}

// Clears the Spotify session (tokens) and any session-scoped data. Keeps the
// stored Client ID + selected playlists so the user doesn't have to redo
// onboarding when they log back in.
export function logout() {
  localStorage.removeItem(LS_ACCESS);
  localStorage.removeItem(LS_REFRESH);
  localStorage.removeItem(LS_EXPIRES);
  clearTracksCache();
}

export async function exchangeCode(code: string) {
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  if (!verifier) throw new Error('missing PKCE verifier');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const data = await res.json();
  storeTokens(data);
  sessionStorage.removeItem(SS_VERIFIER);
}

function storeTokens(data: any) {
  localStorage.setItem(LS_ACCESS, data.access_token);
  if (data.refresh_token) localStorage.setItem(LS_REFRESH, data.refresh_token);
  localStorage.setItem(LS_EXPIRES, String(Date.now() + (data.expires_in - 30) * 1000));
}

async function refresh(): Promise<string | null> {
  const refresh_token = localStorage.getItem(LS_REFRESH);
  if (!refresh_token) return null;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'refresh_token',
      refresh_token,
    }),
  });
  if (!res.ok) {
    logout();
    return null;
  }
  const data = await res.json();
  storeTokens(data);
  return data.access_token;
}

async function getToken(): Promise<string | null> {
  const access = localStorage.getItem(LS_ACCESS);
  const expires = Number(localStorage.getItem(LS_EXPIRES) || 0);
  if (access && Date.now() < expires) return access;
  return refresh();
}

export function isLoggedIn() {
  return !!localStorage.getItem(LS_REFRESH);
}

export async function spotify(path: string, init: RequestInit = {}, _retry = 0): Promise<any> {
  const token = await getToken();
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 204) return null;
  if (res.status === 401 && _retry === 0) {
    // Token may have been revoked or expired; refresh once and retry.
    // _retry guard ensures we never loop on a persistently-bad token.
    const t = await refresh();
    if (!t) throw new Error('not authenticated');
    return spotify(path, init, _retry + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

export type JukeTrack = {
  uri: string;
  name: string;
  artist: string;
  album: string;
  source: 'now' | 'queue' | 'playlist';
  // Spotify context URI (`spotify:playlist:...` / `spotify:album:...`) the track
  // was discovered in. When set, play() uses it as context_uri + offset so
  // Spotify keeps playing the next track in the playlist after this one ends,
  // instead of stopping cold.
  contextUri?: string;
};

function toTrack(t: any, source: JukeTrack['source'], contextUri?: string): JukeTrack | null {
  if (!t?.uri) return null;
  return {
    uri: t.uri,
    name: t.name ?? '',
    artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    album: t.album?.name ?? '',
    source,
    contextUri,
  };
}

export async function loadAllTracks(playlistIds: string[]) {
  const out: JukeTrack[] = [];
  const seen = new Set<string>();
  const add = (t: JukeTrack | null) => {
    if (!t || seen.has(t.uri)) return;
    seen.add(t.uri);
    out.push(t);
  };

  let nowItem: any = null;
  try {
    const now = await spotify('/me/player/currently-playing');
    if (now?.item) {
      // now.context?.uri tells us where playback was started from — usually a
      // spotify:playlist:... or spotify:album:... URI. Carrying it forward
      // means tapping the now-playing card later plays it back IN that
      // context (rather than starting a single-track stop-after-this play).
      add(toTrack(now.item, 'now', now.context?.uri));
      nowItem = now.item;
    } else console.info('[jukebox] now-playing: nothing active');
  } catch (e) { console.error('[jukebox] now-playing failed:', e); }

  try {
    const q = await spotify('/me/player/queue');
    if (Array.isArray(q?.queue)) {
      console.info(`[jukebox] queue: ${q.queue.length} tracks`);
      // Queue items don't carry their original playlist context, so play
      // falls back to single-URI play for these.
      for (const t of q.queue) add(toTrack(t, 'queue'));
    } else {
      console.info('[jukebox] queue: empty (no active device?)');
    }
  } catch (e) { console.error('[jukebox] queue failed:', e); }

  for (const id of playlistIds) {
    try {
      // Use /playlists/{id} (not /playlists/{id}/tracks — that sub-endpoint
      // 403s for many accounts). The container can show up as either
      // `tracks` or `items`, and each row's track as `track` or `item`,
      // depending on whether Spotify served the legacy or additional-types
      // shape — accept both.
      const p: any = await spotify(`/playlists/${id}`);
      const container = p?.items ?? p?.tracks;
      let items: any[] = container?.items ?? [];
      let next: string | null = container?.next ?? null;
      while (next) {
        const path = next.replace('https://api.spotify.com/v1', '');
        const page: any = await spotify(path);
        items = items.concat(page?.items ?? []);
        next = page?.next ?? null;
      }
      const contextUri = `spotify:playlist:${id}`;
      for (const it of items) add(toTrack(it.item ?? it.track, 'playlist', contextUri));
      console.info(`[jukebox] playlist ${id}: ${items.length} tracks`);
    } catch (e) {
      console.error(`[jukebox] playlist ${id} failed:`, e);
    }
  }
  console.info(`[jukebox] total tracks: ${out.length}`);

  return { tracks: out, nowItem };
}

export type UserPlaylist = { id: string; name: string; image: string | null; tracks: number };
export async function getUserPlaylists(): Promise<UserPlaylist[]> {
  const out: UserPlaylist[] = [];
  let url: string | null = '/me/playlists?limit=50';
  while (url) {
    const p: any = await spotify(url);
    if (Array.isArray(p?.items)) {
      for (const it of p.items) {
        // Spotify returns count under `tracks.total` in the legacy shape and
        // `items.total` in the newer additional_types-aware shape.
        const total = it?.tracks?.total ?? it?.items?.total ?? 0;
        out.push({
          id: it.id,
          name: it.name,
          image: it.images?.[0]?.url ?? null,
          tracks: total,
        });
      }
    }
    url = p?.next ? p.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return out;
}

// --- localStorage cache for selected playlists + their fetched tracks ---
const SEL_KEY = 'jukebox_selected_playlists';
const TRACKS_KEY = 'jukebox_tracks_cache';
const TRACKS_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getSelectedPlaylists(): string[] {
  try { return JSON.parse(localStorage.getItem(SEL_KEY) || '[]'); } catch { return []; }
}
export function saveSelectedPlaylists(ids: string[]) {
  localStorage.setItem(SEL_KEY, JSON.stringify(ids));
}
function cacheKey(ids: string[]) { return [...ids].sort().join(','); }
export function getCachedTracks(ids: string[]): { tracks: JukeTrack[]; nowItem: any } | null {
  try {
    const raw = localStorage.getItem(TRACKS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.idsKey !== cacheKey(ids)) return null;
    if (Date.now() - obj.timestamp > TRACKS_TTL_MS) return null;
    return { tracks: obj.tracks, nowItem: obj.nowItem };
  } catch { return null; }
}
export function setCachedTracks(ids: string[], tracks: JukeTrack[], nowItem: any) {
  try {
    localStorage.setItem(TRACKS_KEY, JSON.stringify({
      idsKey: cacheKey(ids), timestamp: Date.now(), tracks, nowItem,
    }));
  } catch {}
}
export function clearTracksCache() { localStorage.removeItem(TRACKS_KEY); }
// IDs that are currently part of a live (non-expired) tracks cache. Used by
// the playlist picker to show a "cached" badge per row.
export function getCachedPlaylistIds(): string[] {
  try {
    const raw = localStorage.getItem(TRACKS_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw);
    if (Date.now() - obj.timestamp > TRACKS_TTL_MS) return [];
    return String(obj.idsKey || '').split(',').filter(Boolean);
  } catch { return []; }
}

// Toggle Spotify's shuffle state for the user's playback. 204 No Content on
// success; 404 if there's no active device — we ignore that and let the
// caller no-op, since setting shuffle without playback is meaningless.
export async function setShuffle(state: boolean) {
  return spotify(`/me/player/shuffle?state=${state}`, { method: 'PUT' });
}

// Append a track to the Spotify playback queue. 204 on success, 404 if no
// active device. Caller should ensure there's an active device first (we
// surface this via the "tap a card to start" UX before queueing is useful).
export async function addToQueue(uri: string) {
  return spotify(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
}

// Play a track. If `contextUri` is supplied (typically the playlist or album
// the track was discovered in), Spotify plays the track within that context
// and auto-continues to the next track when this one ends — so the user gets
// a continuous listening session instead of "song plays, silence".
//
// Without `contextUri`, single-URI play is used (the legacy stop-after-this
// behavior), or — if `uri` is a context URI itself — that context is played
// from the start.
export async function play(uri?: string, contextUri?: string) {
  let body: any;
  if (uri && contextUri) {
    body = { context_uri: contextUri, offset: { uri } };
  } else if (uri) {
    body = uri.startsWith('spotify:track:') ? { uris: [uri] } : { context_uri: uri };
  }
  return spotify('/me/player/play', {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}
export const nowPlaying = () => spotify('/me/player/currently-playing');
