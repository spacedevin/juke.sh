'use client';
import { useEffect, useState } from 'react';
import { isLoggedIn, login, getStoredClientId, setStoredClientId } from '@/lib/spotify-client';

export default function Landing() {
  const [clientId, setClientId] = useState('');
  // Lets us render different UI for logged-in vs logged-out without
  // auto-redirecting. The landing page is now a hub — pick your destination
  // (enter the jukebox, log out, demo mode) instead of getting bounced.
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => {
    // On localhost, render the logged-in state regardless of actual auth so
    // we can preview the logout button + post-login layout without going
    // through the full Spotify OAuth round-trip every time we tweak CSS.
    const onLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    setLoggedIn(isLoggedIn() || onLocalhost);
    setClientId(getStoredClientId());
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStoredClientId(clientId);
    login();
  };

  return (
    <div className="center-screen">
      <div className="landing-title">juke.sh/BOX</div>
      <div className="landing-tag">Spotify WebGL Jukebox</div>
      <br />
      {loggedIn ? (
        <div className="auth-form">
          <a className="sp-btn" href="/box">ENTER THE JUKEBOX</a>
          <a className="sp-btn sp-btn-secondary" href="/logout">LOG OUT</a>
          <div className="auth-hint">
            You're signed in to Spotify.
            <br /><br /><br /><br /><br />
            <a href="/dev">Or take it for a test spin →</a>
          </div>
        </div>
      ) : (
      <form className="auth-form" onSubmit={onSubmit}>
        <input
          className="client-id-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Spotify Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
        <button className="sp-btn" type="submit">LOGIN WITH SPOTIFY</button>

        <div className="auth-hint">
          Create a Spotify app to get a Client ID<br />(free, takes ~1 minute).
          {' '}
          <a href="https://github.com/spacedevin/juke.sh/blob/main/USER_GUIDE.md" target="_blank" rel="noopener noreferrer">
            How →
          </a>
          <br /><br /><br /><br /><br />
          <a href="/dev">
          Take it for a test spin without an ID →
        </a>
        </div>


      </form>
      )}

      <style jsx>{`
        .auth-form { display: flex; flex-direction: column; align-items: stretch; gap: 10px; width: min(360px, 86vw); }
        .client-id-input {
          background: rgba(20,10,15,0.85);
          color: #fff;
          border: 2px solid rgba(0,255,136,0.35);
          border-radius: 8px;
          padding: 10px 14px;
          font-family: inherit;
          font-size: 13px;
          letter-spacing: 1px;
          text-align: center;
          outline: none;
        }
        .client-id-input::placeholder { color: rgba(255,255,255,0.35); letter-spacing: 1px; }
        .client-id-input:focus { border-color: #00ff88; }
        .auth-hint { font-size: 11px; color: #888; letter-spacing: 0.5px; padding: 4px 0 0; }
        .auth-hint a { color: #00ff88; text-decoration: none; }
        .auth-hint a:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
}
