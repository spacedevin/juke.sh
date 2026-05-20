'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { logout } from '@/lib/spotify-client';

// /logout — clears the Spotify session and bounces back to the landing page.
// Kept as a dedicated route so it can be linked to from anywhere (settings,
// landing page, footer, etc.) and bookmarked.
//
// Note: this only clears OUR tokens locally. To fully revoke juke.sh's access
// from the Spotify side, the user must remove the app at
// https://www.spotify.com/account/apps/ — we surface that link below.
export default function Logout() {
  const router = useRouter();
  useEffect(() => {
    logout();
    router.replace('/');
  }, [router]);
  return (
    <div className="center-screen">
      <div className="loading-text">Logging out…</div>
    </div>
  );
}
