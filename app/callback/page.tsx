'use client';
import { useEffect, useState } from 'react';
import { exchangeCode, consumeState } from '@/lib/spotify-client';

export default function Callback() {
  const [msg, setMsg] = useState('Completing login…');
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    if (err) { setMsg(`Auth error: ${err}`); return; }
    if (!code) { setMsg('Missing code'); return; }
    // CSRF guard — value must match the state we generated in login().
    const expected = consumeState();
    if (!expected || expected !== state) {
      setMsg('State mismatch — login may have been tampered with. Please retry.');
      return;
    }
    exchangeCode(code)
      .then(() => { window.location.replace('/box'); })
      .catch((e) => setMsg(String(e.message || e)));
  }, []);
  return <p style={{ fontFamily: 'monospace', padding: 20, color: '#fff' }}>{msg}</p>;
}
