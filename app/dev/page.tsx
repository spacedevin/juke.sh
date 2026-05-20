import Jukebox from '../jukebox';

// Localhost + dev-only visual playground. Skips Spotify auth and loads
// procedural debug tracks. In production builds the debug-tracks module is
// tree-shaken (`process.env.NODE_ENV !== 'production'` guard in Jukebox), so
// hitting /dev on a deployed site falls through to the "not allowed" message.
export default function Dev() {
  return <Jukebox debug demo />;
}
