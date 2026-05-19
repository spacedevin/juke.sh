'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn, login, getStoredClientId, setStoredClientId } from '@/lib/spotify-client';

export default function Landing() {
  const router = useRouter();
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    if (isLoggedIn()) router.replace('/box');
    setClientId(getStoredClientId());
  }, [router]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setStoredClientId(clientId);
    login();
  };

  return (
    <div className="center-screen">
      <div className="landing-title">juke.sh/BOX</div>
      <div className="landing-tag">Spotify WebGL Jukebox</div>

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
          Create a Spotify app to get a Client ID (free, ~1 minute).
          {' '}
          <a href="https://github.com/spacedevin/juke.sh/blob/main/USER_GUIDE.md" target="_blank" rel="noopener noreferrer">
            How →
          </a>
        </div>
      </form>

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
