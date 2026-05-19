'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn, login } from '@/lib/spotify-client';

export default function Landing() {
  const router = useRouter();
  useEffect(() => {
    if (isLoggedIn()) router.replace('/box');
  }, [router]);

  return (
    <div className="center-screen">
      <div className="landing-title">juke.sh/BOX</div>
      <div className="landing-tag">50s diner records, on your Spotify</div>
      <button className="sp-btn" onClick={() => login()}>LOGIN WITH SPOTIFY</button>
    </div>
  );
}
