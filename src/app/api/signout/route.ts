import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sameOrigin } from "@/lib/auth/session";

/** Sign out: clears the session cookie and returns to the sign-in page. A POST from this site only, so no link elsewhere can sign someone out. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req.headers, req.url)) return new NextResponse("Sign-out is accepted only from this site.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const res = new NextResponse(null, { status: 303, headers: { Location: "/signin", "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
