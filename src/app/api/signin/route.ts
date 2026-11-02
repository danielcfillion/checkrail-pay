import { NextResponse, type NextRequest } from "next/server";
import { authenticatePassword, configuredUsers } from "@/lib/basicAuth";
import { FAIL_WINDOW_MS, SESSION_COOKIE, SESSION_MAX_AGE, gateAttempt, safeNext, sameOrigin, sessionKey, signInUrl, signSession } from "@/lib/auth/session";
import { clientIp, newThrottle } from "@/lib/throttle";

/**
 * The sign-in form's POST. A plain HTML form, so it works with JavaScript off: every answer is a 303 redirect, either
 * on to the page that was asked for (with the session cookie set) or back to /signin with a short error code.
 *
 * The same protections as Basic auth in the middleware: the per-address wrong-password throttle (this route keeps its
 * own counter, as the edge middleware and this Node route do not share memory; each allows ten wrong passwords per
 * address in 15 minutes), the constant-time compare, and the opt-in failed-login log line. The form must come from
 * this site (Origin), so another site cannot sign a visitor in to an account of its choosing.
 */
export const dynamic = "force-dynamic";

const failures = newThrottle();

function back(location: string, extra?: Record<string, string>): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req.headers, req.url)) return new NextResponse("Sign-in is accepted only from this site's own sign-in page.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return back(signInUrl("/", "invalid"));
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.slice(0, 256) : "";
  };
  const next = safeNext(field("next"));
  const users = configuredUsers();
  if (users === null) return new NextResponse("The login settings are malformed; refusing.", { status: 503 });
  // Nothing configured: the middleware already lets everyone in (development only), so there is nothing to sign in to.
  if (users.length === 0) return back(next);
  const key = sessionKey(process.env);
  if (!key) return back(signInUrl(next, "unavailable"));
  const username = field("username").trim();
  const password = field("password");
  const offered = Boolean(username || password);
  const who = offered ? authenticatePassword(username, password, users) : null;
  const ip = clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER);
  const gate = gateAttempt({ throttle: failures, ip, users, who, attempted: offered, headers: req.headers });
  if (gate === "throttled") return back(signInUrl(next, "throttled"), { "Retry-After": String(Math.ceil(FAIL_WINDOW_MS / 1000)) });
  if (gate !== "ok" || !who) return back(signInUrl(next, "wrong"));
  const https = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
  const res = back(next);
  res.cookies.set(SESSION_COOKIE, signSession(who, key), { httpOnly: true, secure: https || process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  return res;
}
