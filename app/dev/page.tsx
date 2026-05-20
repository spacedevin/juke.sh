import Jukebox from '../jukebox';

// Visual playground — skips Spotify auth and loads procedural debug tracks.
// Works everywhere, including production. No login required, useful for
// recordings / screenshots / sharing the look. Auto-rotation defaults to 0;
// press the left/right arrow keys to start a spin.
export default function Dev() {
  return <Jukebox debug />;
}
