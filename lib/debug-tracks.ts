// Procedural fake tracks for visual debugging — adapted from the spin7.html
// prototype. Pure data + a deterministic generator; no network, no Spotify.
//
// Webpack/Next strips `process.env.NODE_ENV === 'production'` branches at
// build time, so consumers should always gate dynamic imports of this file
// behind that check. Combined with the localhost-only `isDebugAllowed` guard,
// the debug code path is unreachable in production deployments.

import type { JukeTrack } from './spotify-client';

const artists = [
  'Elvis Presley', 'Chuck Berry', 'Little Richard', 'Fats Domino', 'Buddy Holly',
  'Jerry Lee Lewis', 'Gene Vincent', 'Roy Orbison', 'Everly Brothers', 'Ray Charles',
  'Sam Cooke', 'Jackie Wilson', 'The Drifters', 'The Coasters', 'Dion', 'Patsy Cline',
  'Brenda Lee', 'Bill Haley', 'Carl Perkins', 'Ricky Nelson', 'Wanda Jackson',
  'Ritchie Valens', 'Frank Sinatra', 'Dean Martin', 'Paul Anka', 'Johnny Cash',
  'The Platters', 'Etta James',
];
const adjectives = [
  'Blue', 'Crazy', 'Sweet', "Rockin'", 'Wild', 'Lonely', 'Shake', "Rollin'", 'Magic',
  'Jive', 'Good', 'Bad', 'Fast', 'Slow', 'Heartbreak', 'Midnight', 'Silver', 'Golden',
  'Happy', 'Sad', "Twistin'", 'Atomic', 'Neon', 'Plastic', 'Radio',
];
const nouns = [
  'Shoes', 'Love', 'Baby', 'Night', 'Heart', 'Star', 'Moon', 'Cat', 'Dog', 'Train',
  'Tears', 'Dreams', 'Doll', 'Angel', 'Boogie', 'Twist', 'Beat', 'Town', 'River', 'Road',
  'Dance', 'Rocket', 'Juke', 'Diner', 'Flame',
];
const albums = [
  'Greatest Hits', "The Best Of", 'Live at the Hop', 'Sock Hop', 'On The Radio',
  'Diner Days', 'Drive-In Nights', 'The Original Sessions', 'Sun Records',
  '45s & B-Sides', 'Highway Songs', 'Last Call',
];

export function generateDebugTracks(count = 120): JukeTrack[] {
  const out: JukeTrack[] = [];
  for (let i = 0; i < count; i++) {
    const artist = artists[i % artists.length];
    const name = `${adjectives[(i * 3) % adjectives.length]} ${nouns[(i * 7) % nouns.length]}`;
    const album = albums[(i * 5) % albums.length];
    out.push({
      uri: `spotify:track:debug-${i.toString(36)}`,
      name,
      artist,
      album,
      source: 'playlist',
    });
  }
  return out;
}

export function isDebugAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}
