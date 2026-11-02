import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sameOrigin } from "@/lib/auth/session";
import { crossOriginPage } from "@/lib/auth/crossOrigin";

/** Sign out: clears the session cookie and returns to the sign-in page. A POST from this site only, so no link elsewhere can sign someone out. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req.headers, req.url)) return crossOriginPage();
  const res = new NextResponse(null, { status: 303, headers: { Location: "/signin", "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
