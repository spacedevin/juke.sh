// Browser-only Spotify PKCE client.
// Tokens live in localStorage; no server proxy.

const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID!;
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
  const verifier = randomVerifier();
  sessionStorage.setItem(SS_VERIFIER, verifier);
  const code_challenge = await challenge(verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge,
    scope: SCOPES,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export function logout() {
  localStorage.removeItem(LS_ACCESS);
  localStorage.removeItem(LS_REFRESH);
  localStorage.removeItem(LS_EXPIRES);
}

export async function exchangeCode(code: string) {
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  if (!verifier) throw new Error('missing PKCE verifier');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
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
      client_id: CLIENT_ID,
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

export async function getToken(): Promise<string | null> {
  const access = localStorage.getItem(LS_ACCESS);
  const expires = Number(localStorage.getItem(LS_EXPIRES) || 0);
  if (access && Date.now() < expires) return access;
  return refresh();
}

export function isLoggedIn() {
  return !!localStorage.getItem(LS_REFRESH);
}

export async function spotify(path: string, init: RequestInit = {}): Promise<any> {
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
  if (res.status === 401) {
    // Token might've been revoked; try a refresh once
    const t = await refresh();
    if (!t) throw new Error('not authenticated');
    return spotify(path, init);
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
};

function toTrack(t: any, source: JukeTrack['source']): JukeTrack | null {
  if (!t?.uri) return null;
  return {
    uri: t.uri,
    name: t.name ?? '',
    artist: (t.artists ?? []).map((a: any) => a.name).join(', '),
    album: t.album?.name ?? '',
    source,
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
    if (now?.item) { add(toTrack(now.item, 'now')); nowItem = now.item; }
    else console.info('[jukebox] now-playing: nothing active');
  } catch (e) { console.error('[jukebox] now-playing failed:', e); }

  try {
    const q = await spotify('/me/player/queue');
    if (Array.isArray(q?.queue)) {
      console.info(`[jukebox] queue: ${q.queue.length} tracks`);
      for (const t of q.queue) add(toTrack(t, 'queue'));
    } else {
      console.info('[jukebox] queue: empty (no active device?)');
    }
  } catch (e) { console.error('[jukebox] queue failed:', e); }

  for (const id of playlistIds) {
    try {
      // Spotify's response shape varies: new format uses `items.items[].item`,
      // legacy uses `tracks.items[].track`. Handle both. The /tracks sub-endpoint
      // 403s for many accounts so we fetch /playlists/{id} directly.
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
      for (const it of items) add(toTrack(it.item ?? it.track, 'playlist'));
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

export async function play(uri?: string) {
  const body = uri
    ? uri.startsWith('spotify:track:')
      ? { uris: [uri] }
      : { context_uri: uri }
    : undefined;
  return spotify('/me/player/play', {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}
export const pause = () => spotify('/me/player/pause', { method: 'PUT' });
export const skipNext = () => spotify('/me/player/next', { method: 'POST' });
export const nowPlaying = () => spotify('/me/player/currently-playing');
