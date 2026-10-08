import { NextResponse, type NextRequest } from "next/server";
import { ACTOR_HEADER, basicAuthSetting, checkBasicAuth, parseCredential } from "@/lib/basicAuth";

/**
 * Optional HTTP Basic auth. Set CHECKRAIL_BASIC_AUTH=user:pass to turn it on (the old name DUELINE_BASIC_AUTH still works).
 * - Off (variable unset): the app behaves as before, with the demo operator as actor.
 * - On: every page and server action needs the credential; the username becomes
 *   the audit actor via a request header that this middleware sets itself (any
 *   client-supplied copy of the header is overwritten).
 * - Misconfigured (set but not "user:pass"): everything is refused rather than left open.
 * The PayPal webhook route is excluded: PayPal cannot send Basic credentials, and
 * the route verifies PayPal's signature itself.
 */
export function middleware(req: NextRequest) {
  const setting = basicAuthSetting();
  if (!setting) {
    // Never trust a client-supplied actor header when auth is off.
    const headers = new Headers(req.headers);
    headers.delete(ACTOR_HEADER);
    return NextResponse.next({ request: { headers } });
  }
  if (!parseCredential(setting)) {
    return new NextResponse("CHECKRAIL_BASIC_AUTH is set but is not in user:pass form; refusing all requests.", { status: 503 });
  }
  const user = checkBasicAuth(req.headers.get("authorization"), setting);
  if (!user) {
    return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Checkrail Pay", charset="UTF-8"' } });
  }
  const headers = new Headers(req.headers);
  headers.set(ACTOR_HEADER, user);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api/webhooks/|_next/static|_next/image|favicon.ico).*)"],
};
