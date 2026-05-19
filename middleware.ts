import { NextRequest, NextResponse } from 'next/server';

// Make app routes case-insensitive. Any request with uppercase letters in the
// pathname is 308-redirected to the lowercase version (preserving search/hash).
// Hashes don't reach the server, but search params do — keep those intact.
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === pathname.toLowerCase()) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = pathname.toLowerCase();
  return NextResponse.redirect(url, 308);
}

export const config = {
  // Skip static/internal assets so we don't redirect e.g. /Image.png unnecessarily.
  matcher: ['/((?!_next/|api/|.*\\..*).*)'],
};
