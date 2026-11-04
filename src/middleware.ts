import { NextResponse, type NextRequest } from "next/server";
import { ACTOR_HEADER, PERSONA_COOKIE, PERSONA_HEADER, ROLE_HEADER, authenticate, configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { DEMO_PERSONAS } from "@/lib/auth/roles";
import { clientIp, newThrottle, overLimit } from "@/lib/throttle";
import { FAIL_WINDOW_MS, SESSION_COOKIE, gateAttempt, safeNext, sessionKey, signInUrl, verifySession, wantsPage } from "@/lib/auth/session";
import { AUTH_REQUIRED_HTML } from "@/lib/authRequiredPage";
import { SANDBOX_COOKIE, SANDBOX_COOKIE_MAX_AGE, SANDBOX_HEADER, sandboxForRequest, sandboxSetting } from "@/lib/sandbox/settings";

/** Set on public vendor pages so the layout renders them without the app's navigation or business data. */
export const PUBLIC_HEADER = "x-checkrail-public";

/**
 * The inbound REST API's routes, exactly: /api/v1/departures, /api/v1/requests, /api/v1/requests/<id>,
 * /api/v1/vendors and /api/v1/openapi.json. Nothing else under /api/v1 skips the login: a path with no route renders
 * the not-found page inside the app layout, which trusts the identity headers only this middleware may set.
 */
/** The sign-in page and its two form posts. */
export const SIGN_IN_PATHS = new Set(["/signin", "/api/signin", "/api/signout"]);

export const API_V1_PATH = /^\/api\/v1\/(?:departures|requests|vendors|openapi\.json|requests\/[A-Za-z0-9_-]{1,64})$/;

/**
 * Who is asking, on every request.
 *
 *  - Logins configured (CHECKRAIL_USERS, or the single CHECKRAIL_BASIC_AUTH which is an admin): every page and
 *    server action needs one. The username becomes the audit actor and the role decides what they may do. Both
 *    headers are set here; any client-supplied copy is overwritten. A login is either the signed session cookie the
 *    /signin page sets (src/lib/auth/session.ts) or an HTTP Basic header (scripts, tests). Without one, a page request
 *    is sent to /signin and anything else gets a 401 in JSON; no browser password prompt is ever asked for.
 *  - Nothing configured: allowed only in development, or when CHECKRAIL_INSECURE_DEMO=1 is set on purpose. In
 *    production or with live rails the app refuses every request rather than running open (security audit F3).
 *  - A setting present but malformed: everything is refused.
 *  - Demo personas (CHECKRAIL_DEMO_PERSONAS=1, never with real money): an owner login, or anyone on an open
 *    dev server, can act as one of the demo team to see roles at work. The real login is kept in the audit.
 *
 * Exempt, by exact path: the PayPal webhook (PayPal cannot send credentials; the route verifies PayPal's
 * signature itself), the agent endpoint /api/mcp (agents send an agent key, which the route checks) and the vendor onboarding and evidence pages (a vendor has no login; each link carries a
 * single-use token), and the sign-in page with its two form posts (SIGN_IN_PATHS). Static build assets are excluded by the matcher.
 */
/*
 * A small in-memory throttle (per server process, which is what one Render instance is): five wrong passwords (and five more by the sign-in form, src/lib/auth/session.ts) from
 * one address in 15 minutes lock that address out for the rest of the window, and the token pages for vendors take
 * at most 30 requests a minute per address. It slows guessing; it is not a substitute for a strong demo password.
 */
const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_MS = 60_000;
const failures = newThrottle();
const tokenHits = newThrottle();

function tooMany(retryMs: number) {
  return new NextResponse("Too many attempts. Wait a few minutes and try again.", { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs / 1000)) } });
}

/** What a vendor link opened outside the demo browser shows in sandbox mode. */
const SANDBOX_LINK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open this link from the demo</title><style>:root{color-scheme:light dark}body{margin:0;font:15px/22px system-ui,sans-serif;background:#f4f6f9;color:#0a1628}main{max-width:32rem;margin:15vh auto;padding:0 16px}@media (prefers-color-scheme:dark){body{background:#0b111b;color:#e8edf3}}</style></head><body><main><h1 style="font-size:22px">Open this link from the demo</h1><p>Each visitor to this demo has a private copy of it, and this link belongs to one of them. Open it in the same browser where you are using the demo.</p></main></body></html>`;

/*
 * Sandbox mode (CHECKRAIL_SANDBOX=1, simulated rails only; src/lib/sandbox/settings.ts): each browser gets a signed,
 * httpOnly cookie naming its own copy of the demo database, and every request it makes carries that token on to the
 * server in SANDBOX_HEADER, where the database seam picks the copy. A client-sent copy of the header is always
 * replaced. Off, nothing here changes.
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Render's health check: no login, no sandbox copy, no data. It only proves the server answers.
  if (path === "/healthz") return new NextResponse("ok", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  // Server-to-server calls (PayPal's webhook, a scheduler holding the tick token, software holding an API key on
  // /api/v1) are no visitor: no copy for them. An API key works on the shared books, never a sandbox copy.
  const serverToServer = path === "/api/webhooks/paypal" || API_V1_PATH.test(path) || (path === "/api/autopilot/tick" && Boolean(process.env.CHECKRAIL_TICK_TOKEN?.trim()));
  // The sign-in page and the sign-in and sign-out posts touch no data: they never start a sandbox copy.
  const signInPath = SIGN_IN_PATHS.has(path);
  const sandbox = !serverToServer && !signInPath && sandboxSetting(process.env).on ? sandboxForRequest(req.cookies.get(SANDBOX_COOKIE)?.value, process.env) : null;
  const ip = clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER);
  const headers = new Headers(req.headers);
  for (const h of [ACTOR_HEADER, ROLE_HEADER, PERSONA_HEADER, PUBLIC_HEADER, SANDBOX_HEADER]) headers.delete(h);
  if (sandbox) headers.set(SANDBOX_HEADER, sandbox.token);
  const https = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
  // A redirect from middleware needs an absolute address: the production build rejects a bare path with "Invalid URL" and
  // every signed-out page answers 500. The origin is the one the browser used (behind Render's proxy, the forwarded host).
  const redirectTo = (location: string) => {
    const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || req.nextUrl.host;
    const target = new URL(location, `${https ? "https" : "http"}://${host}`).toString();
    return new NextResponse(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store" } });
  };
  const pass = () => {
    const res = NextResponse.next({ request: { headers } });
    if (sandbox?.fresh) res.cookies.set(SANDBOX_COOKIE, sandbox.token, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: SANDBOX_COOKIE_MAX_AGE });
    return res;
  };

  if (path === "/api/webhooks/paypal") return pass();
  // The sign-in page renders bare (no navigation, no business data); the routes check Origin and passwords themselves.
  if (signInPath) {
    if (path === "/signin") {
      // Already signed in: straight on to the page they asked for.
      const signedIn = configuredUsers();
      if (signedIn?.length && verifySession(req.cookies.get(SESSION_COOKIE)?.value, signedIn, sessionKey(process.env))) {
        return redirectTo(safeNext(req.nextUrl.searchParams.get("next")));
      }
      headers.set(PUBLIC_HEADER, "1");
    }
    return pass();
  }
  // Outside agents hold an agent key, not a login; the route checks the key itself (src/app/api/mcp/route.ts).
  if (path === "/api/mcp") return pass();
  // Other software holds an API key, not a login; each /api/v1 route checks the key itself (src/lib/api/http.ts).
  if (API_V1_PATH.test(path)) return pass();
  // An external scheduler holds CHECKRAIL_TICK_TOKEN, not a login; the route checks the token itself.
  if (path === "/api/autopilot/tick" && process.env.CHECKRAIL_TICK_TOKEN?.trim()) return pass();
  if (/^\/(onboard|evidence|remit)\/[A-Za-z0-9_-]{20,80}$/.test(path)) {
    if (overLimit(tokenHits, ip, TOKEN_LIMIT, TOKEN_WINDOW_MS)) return tooMany(TOKEN_WINDOW_MS);
    // Sandbox mode: a vendor link belongs to the copy it was made in. It opens in the browser that has that copy; a
    // browser without one gets a plain page instead of a new copy, so these unauthenticated paths can never fill the pool.
    if (sandbox?.fresh) return new NextResponse(SANDBOX_LINK_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    headers.set(PUBLIC_HEADER, "1");
    return pass();
  }

  const users = configuredUsers();
  if (users === null) return new NextResponse("CHECKRAIL_USERS or CHECKRAIL_BASIC_AUTH is set but malformed (user:password:role, comma separated), or, with live PayPal, public Stellar or live Wise, a password is under 12 characters; refusing all requests.", { status: 503 });

  let actor: string;
  let role: string;
  if (users.length > 0) {
    // A valid session cookie from the sign-in page, or the Basic header that scripts and tests send.
    const key = sessionKey(process.env);
    const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value, users, key);
    const authorization = req.headers.get("authorization");
    const basic = session ? null : authenticate(authorization, users);
    // A session was signed only after a password passed this same throttle, so it is not a guess and is not held back.
    const gate = session ? "ok" : gateAttempt({ throttle: failures, ip, users, who: basic, attempted: Boolean(authorization), headers: req.headers });
    if (gate === "throttled") return tooMany(FAIL_WINDOW_MS);
    const who = session ?? basic;
    if (!who) {
      // No form sign-in possible (production with no secret to sign sessions): the browser's own prompt, as before.
      if (!key) return new NextResponse(AUTH_REQUIRED_HTML, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Checkrail Pay", charset="UTF-8"', "Content-Type": "text/html; charset=utf-8" } });
      // A browser asking for a page goes to the sign-in page, with no challenge header, so no pop-up appears.
      if (wantsPage(req.method, req.headers)) return redirectTo(signInUrl(path + req.nextUrl.search));
      // Fetches, server actions, RSC and API calls get JSON. The challenge goes only to a client that sent Basic itself.
      const h: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (authorization) h["WWW-Authenticate"] = 'Basic realm="Checkrail Pay", charset="UTF-8"';
      return new NextResponse(JSON.stringify({ error: "Sign in required.", signIn: "/signin" }), { status: 401, headers: h });
    }
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
  return pass();
}

export const config = {
  // /api/mcp is left out entirely: the route checks the agent key itself, and a matched request has its body copied
  // (up to 10 MB) for the middleware before the route's own 64 KB limit can refuse it.
  // The /api/v1 routes (API_V1_PATH) are left out the same way, and only those: each checks its API key and body cap.
  matcher: ["/((?!_next/static/|api/mcp$|api/v1/(?:departures|requests|vendors|openapi\\.json|requests/[A-Za-z0-9_-]{1,64})$).*)"],
};
