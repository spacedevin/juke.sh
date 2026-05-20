import { type NextRequest, NextResponse } from 'next/server';

// Make app routes case-insensitive. Any request with uppercase letters in the
// pathname is 308-redirected to the lowercase version. clone() preserves the
// search params automatically — we only mutate `pathname` below — and hashes
// never reach the server.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === pathname.toLowerCase()) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = pathname.toLowerCase();
  return NextResponse.redirect(url, 308);
}

export const config = {
  // Skip static/internal assets so we don't redirect e.g. /Image.png unnecessarily.
  matcher: ['/((?!_next/|api/|.*\\..*).*)'],
};
