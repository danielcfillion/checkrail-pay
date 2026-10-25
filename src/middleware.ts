import { NextResponse, type NextRequest } from "next/server";
import { ACTOR_HEADER, PERSONA_COOKIE, PERSONA_HEADER, ROLE_HEADER, authenticate, configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { DEMO_PERSONAS } from "@/lib/auth/roles";

/** Set on public vendor pages so the layout renders them without the app's navigation or business data. */
export const PUBLIC_HEADER = "x-checkrail-public";

/**
 * Who is asking, on every request.
 *
 *  - Logins configured (CHECKRAIL_USERS, or the single CHECKRAIL_BASIC_AUTH which is an admin): every page and
 *    server action needs one. The username becomes the audit actor and the role decides what they may do. Both
 *    headers are set here; any client-supplied copy is overwritten.
 *  - Nothing configured: allowed only in development, or when CHECKRAIL_INSECURE_DEMO=1 is set on purpose. In
 *    production or with live rails the app refuses every request rather than running open (security audit F3).
 *  - A setting present but malformed: everything is refused.
 *  - Demo personas (CHECKRAIL_DEMO_PERSONAS=1, never with real money): an owner login, or anyone on an open
 *    dev server, can act as one of the demo team to see roles at work. The real login is kept in the audit.
 *
 * Exempt, by exact path: the PayPal webhook (PayPal cannot send credentials; the route verifies PayPal's
 * signature itself) and the vendor onboarding and evidence pages (a vendor has no login; each link carries a
 * single-use token). Static build assets are excluded by the matcher.
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const headers = new Headers(req.headers);
  for (const h of [ACTOR_HEADER, ROLE_HEADER, PERSONA_HEADER, PUBLIC_HEADER]) headers.delete(h);

  if (path === "/api/webhooks/paypal") return NextResponse.next({ request: { headers } });
  if (/^\/(onboard|evidence|remit)\/[A-Za-z0-9_-]{20,80}$/.test(path)) {
    headers.set(PUBLIC_HEADER, "1");
    return NextResponse.next({ request: { headers } });
  }

  const users = configuredUsers();
  if (users === null) return new NextResponse("CHECKRAIL_USERS or CHECKRAIL_BASIC_AUTH is set but malformed (user:password:role, comma separated); refusing all requests.", { status: 503 });

  let actor: string;
  let role: string;
  if (users.length > 0) {
    const who = authenticate(req.headers.get("authorization"), users);
    if (!who) return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Checkrail Pay", charset="UTF-8"' } });
    actor = who.user;
    role = who.role;
  } else {
    const open = process.env.NODE_ENV !== "production" || process.env.CHECKRAIL_INSECURE_DEMO === "1";
    if (!open || process.env.RAIL_MODE === "live") {
      return new NextResponse("No logins are configured. Set CHECKRAIL_USERS (user:password:role, comma separated) or CHECKRAIL_BASIC_AUTH. For an open demo on mock rails only, set CHECKRAIL_INSECURE_DEMO=1.", { status: 503 });
    }
    actor = "daniel";
    role = "admin";
  }

  // Only an owner login may act as someone else: a clerk switching to the owner would be a privilege escalation.
  const personasOn = role === "admin" && personasAllowed(process.env, users.length > 0);
  const persona = personasOn ? DEMO_PERSONAS.find((p) => p.username === req.cookies.get(PERSONA_COOKIE)?.value) : undefined;
  if (persona) {
    headers.set(PERSONA_HEADER, actor);
    actor = persona.username;
    role = persona.role;
  }
  headers.set(ACTOR_HEADER, actor);
  headers.set(ROLE_HEADER, role);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static/).*)"],
};
