import { Github, Music2 } from 'lucide-react';

export const metadata = { title: 'juke.sh - Spotify WebGL Jukebox' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Arimo:wght@400;700&family=Bebas+Neue&family=Bangers&family=Bungee&family=Chicle&family=Cinzel:wght@700&family=Cookie&family=Corben&family=Courier+Prime:wght@400;700&family=Damion&family=Erica+One&family=Fascinate&family=Fascinate+Inline&family=Fjalla+One&family=Fugaz+One&family=JetBrains+Mono:wght@400;500;700&family=Leckerli+One&family=Limelight&family=Lobster&family=Monoton&family=Oswald:wght@500;700&family=Pacifico&family=Playfair+Display:wght@900&family=Poiret+One&family=Rampart+One&family=Righteous&family=Rubik+Mono+One&family=Russo+One&family=Satisfy&family=Shrikhand&family=Sigmar+One&family=Space+Mono&family=Special+Elite&family=Ultra&family=Vampiro+One&family=Yellowtail&family=Abril+Fatface&family=Permanent+Marker&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/android-chrome-192x192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/android-chrome-512x512.png" />
        <meta name="theme-color" content="#ffffff" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover"
        />
        <style>{`
          html, body {
            margin: 0;
            background: black;
            color: #fff;
            font-family: 'JetBrains Mono', ui-monospace, monospace;
            text-align: center;
          }
          .center-screen {
            position: fixed; inset: 0; z-index: 30;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: clamp(14px, 3vw, 24px);
            padding: clamp(16px, 4vw, 24px);
            padding-bottom: calc(40px + env(safe-area-inset-bottom));
            overflow-y: auto;
            box-sizing: border-box;
          }
          .landing-title {
            font-family: 'JetBrains Mono', ui-monospace, monospace;
            font-size: clamp(34px, 10vw, 64px);
            letter-spacing: clamp(2px, 0.6vw, 4px);
            color: #00ff88;
            text-shadow: 0 0 20px rgba(0,255,136,0.4);
            line-height: 1.1;
            max-width: 100%;
            word-break: break-word;
          }
          .landing-tag {
            color: #888;
            font-size: clamp(11px, 2.6vw, 14px);
            letter-spacing: clamp(1px, 0.4vw, 2px);
            text-transform: uppercase;
            max-width: 90vw;
          }
          .loading-text { color: #ccc; font-size: 14px; letter-spacing: 2px; text-transform: uppercase; }
          .sp-btn {
            background: rgba(20,10,15,0.85);
            color: #00ff88;
            border: 2px solid #00ff88;
            padding: 10px 18px;
            border-radius: 8px;
            font-size: 14px;
            letter-spacing: 1px;
            font-family: inherit;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: background-color 0.15s, color 0.15s;
          }
          .sp-btn:hover { background: rgba(0,255,136,0.12); }
          .sp-btn:disabled { opacity: 0.35; cursor: default; }
          .sp-btn.sp-btn-icon { width: 36px; height: 36px; padding: 0; font-size: 18px; display: inline-flex; align-items: center; justify-content: center; }
          .sp-btn.picked { background: #00ff88; color: #0a0a0a; }
          /* Muted variant — used for destructive / secondary actions
             (e.g. LOG OUT) so they don't compete with the primary CTA. */
          .sp-btn.sp-btn-secondary { color: rgba(255,255,255,0.6); border-color: rgba(255,255,255,0.25); }
          .sp-btn.sp-btn-secondary:hover { color: #fff; border-color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.05); }
          .spinner {
            width: 38px; height: 38px;
            border: 3px solid rgba(0,255,136,0.18);
            border-top-color: #00ff88;
            border-radius: 50%;
            animation: sp 0.9s linear infinite;
          }
          @keyframes sp { to { transform: rotate(360deg); } }

          .site-footer {
            position: fixed;
            bottom: calc(8px + env(safe-area-inset-bottom));
            left: 0;
            right: 0;
            z-index: 100;
            display: flex;
            justify-content: center;
            pointer-events: none;
            padding: 0 12px;
          }
          .site-footer a {
            pointer-events: auto;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            letter-spacing: 1px;
            color: rgba(255,255,255,0.45);
            text-decoration: none;
            padding: 4px 10px;
            border-radius: 999px;
            transition: color 0.15s, background-color 0.15s;
            text-shadow: 0 0 8px rgba(0,0,0,0.8);
            background: rgba(0,0,0,0.6);

          }
          .site-footer a:hover {
            color: #00ff88;
            background: rgba(0,0,0,0.4);
          }
          .site-footer svg { width: 12px; height: 12px; }
          .site-footer .heart { color: #ff4d6d; }
        `}</style>
      </head>
      <body>
        {children}
        <footer className="site-footer">
          <a
            href="https://github.com/spacedevin/juke.sh"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github />
            <span>Made with</span>
            <Music2 className="heart" fill="currentColor" />
            <span>by space.la</span>
          </a>
        </footer>
      </body>
    </html>
  );
}
