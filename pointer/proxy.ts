import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (file convention + function name).
 * See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 *
 * This is a LIGHT cookie presence check only — it does not validate the session
 * against the database. Per Better Auth guidance, do the full session check inside
 * server components / route handlers / server actions where you have DB access.
 */
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Protect /dashboard and any other authed area; everything else (including /api/auth/*) is public.
  matcher: ["/dashboard/:path*", "/flow/:path*", "/choose-plan"],
};
