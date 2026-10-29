import { NextResponse, type NextRequest } from "next/server";
import { ACTOR_HEADER, PERSONA_COOKIE, PERSONA_HEADER, ROLE_HEADER, authenticate, configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { DEMO_PERSONAS } from "@/lib/auth/roles";
import { clientIp, newThrottle, overLimit } from "@/lib/throttle";

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
/*
 * A small in-memory throttle (per server process, which is what one Render instance is): ten wrong passwords from
 * one address in 15 minutes lock that address out for the rest of the window, and the token pages for vendors take
 * at most 30 requests a minute per address. It slows guessing; it is not a substitute for a strong demo password.
 */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_MS = 60_000;
const failures = newThrottle();
const tokenHits = newThrottle();

function tooMany(retryMs: number) {
  return new NextResponse("Too many attempts. Wait a few minutes and try again.", { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs / 1000)) } });
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const ip = clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER);
  const headers = new Headers(req.headers);
  for (const h of [ACTOR_HEADER, ROLE_HEADER, PERSONA_HEADER, PUBLIC_HEADER]) headers.delete(h);

  if (path === "/api/webhooks/paypal") return NextResponse.next({ request: { headers } });
  // An external scheduler holds CHECKRAIL_TICK_TOKEN, not a login; the route checks the token itself.
  if (path === "/api/autopilot/tick" && process.env.CHECKRAIL_TICK_TOKEN?.trim()) return NextResponse.next({ request: { headers } });
  if (/^\/(onboard|evidence|remit)\/[A-Za-z0-9_-]{20,80}$/.test(path)) {
    if (overLimit(tokenHits, ip, TOKEN_LIMIT, TOKEN_WINDOW_MS)) return tooMany(TOKEN_WINDOW_MS);
    headers.set(PUBLIC_HEADER, "1");
    return NextResponse.next({ request: { headers } });
  }

  const users = configuredUsers();
  if (users === null) return new NextResponse("CHECKRAIL_USERS or CHECKRAIL_BASIC_AUTH is set but malformed (user:password:role, comma separated); refusing all requests.", { status: 503 });

  let actor: string;
  let role: string;
  if (users.length > 0) {
    if (overLimit(failures, ip, FAIL_LIMIT, FAIL_WINDOW_MS, Date.now(), false)) return tooMany(FAIL_WINDOW_MS);
    const who = authenticate(req.headers.get("authorization"), users);
    // A missing header is the browser asking for the password prompt, not a guess; only wrong passwords count.
    if (!who && req.headers.get("authorization")) overLimit(failures, ip, FAIL_LIMIT, FAIL_WINDOW_MS);
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
  // With no persona chosen, an owner login plays the demo's owner (Daniel), so every page and the audit log name the
  // same person. The real login is still recorded on every row.
  const chosen = req.cookies.get(PERSONA_COOKIE)?.value ?? DEMO_PERSONAS.find((p) => p.role === "admin")?.username;
  const found = personasOn ? DEMO_PERSONAS.find((p) => p.username === chosen) : undefined;
  const persona = found && found.username !== actor ? found : undefined;
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
