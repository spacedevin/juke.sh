import { Github, Heart } from 'lucide-react';

export const metadata = { title: 'Jukebox' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Bebas+Neue&family=Courier+Prime:wght@400;700&family=Fjalla+One&family=Impact&family=JetBrains+Mono:wght@400;500;700&family=Oswald:wght@500;700&family=Righteous&family=Pacifico&family=Lobster&family=Fascinate&family=Limelight&family=Poiret+One&family=Yellowtail&family=Satisfy&family=Permanent+Marker&family=Shrikhand&family=Monoton&family=Bungee&family=Rampart+One&family=Cinzel:wght@700&family=Playfair+Display:wght@900&family=Abril+Fatface&family=Rubik+Mono+One&family=Bangers&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/android-chrome-192x192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/android-chrome-512x512.png" />
        <meta name="theme-color" content="#ffffff" />
        <style>{`
          html, body {
            margin: 0;
            background: black;
            color: #fff;
            font-family: 'JetBrains Mono', 'Courier Prime', ui-monospace, monospace;
            text-align: center;
          }
          .center-screen {
            position: fixed; inset: 0; z-index: 30;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 24px; padding: 24px;
          }
          .landing-title { font-family: 'JetBrains Mono'; font-size: 64px; letter-spacing: 4px; color: #00ff88; text-shadow: 0 0 20px rgba(0,255,136,0.4); }
          .landing-tag { color: #888; font-size: 14px; letter-spacing: 2px; text-transform: uppercase; }
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
            bottom: 8px;
            left: 0;
            right: 0;
            z-index: 100;
            display: flex;
            justify-content: center;
            pointer-events: none;
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
            <Heart className="heart" fill="currentColor" />
            <span>by space.la</span>
          </a>
        </footer>
      </body>
    </html>
  );
}
