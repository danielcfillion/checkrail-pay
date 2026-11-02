/**
 * The sign-in page's session cookie, and the password check it shares with HTTP Basic. Pure and synchronous, so the
 * same code runs in the edge middleware (which reads the cookie) and in the Node route that signs people in.
 *
 * The cookie is "<username, base64url>.<expiry, seconds since 1970 in base 36>.<signature>". The signature is
 * HMAC-SHA256 over the username, the expiry and a hash of that login's current password, so changing a password or
 * removing a login ends its sessions at once. The role is never in the cookie: it is read from CHECKRAIL_USERS on
 * every request, like Basic auth.
 *
 * The signing key, first one set wins:
 *   CHECKRAIL_SESSION_SECRET  (16 characters or more; render.yaml generates one)
 *   CHECKRAIL_SANDBOX_SECRET  (16 or more)
 *   CHECKRAIL_DATA_KEY        (24 or more)
 *   outside production only: derived from the configured logins themselves, so a development server needs nothing
 *   new and the middleware and the route (separate module instances) agree without sharing state.
 * In production with none of these, the form sign-in is off and the middleware falls back to the browser's Basic prompt.
 */
import { basicAuthSetting, realMoneyEnv, type UserCredential } from "../basicAuth";
import { base64url, hmacSha256, sha256 } from "../sandbox/hmac";
import { sameText } from "../sandbox/settings";
import { overLimit, type Throttle } from "../throttle";

export const SESSION_COOKIE = "checkrail_session";
/** Twelve hours, for the cookie and for the expiry signed inside it. */
export const SESSION_MAX_AGE = 12 * 3600;
export const MIN_SESSION_SECRET = 16;

/**
 * The wrong-password throttle. The edge middleware (Basic) and the Node sign-in route (form) cannot share a counter,
 * so each allows five wrong passwords per address in 15 minutes: ten in all, as before, however they are split.
 */
export const FAIL_LIMIT = 5;
export const FAIL_WINDOW_MS = 15 * 60_000;

type Env = Record<string, string | undefined>;
const enc = new TextEncoder();

/** The HMAC key for session cookies, or null when none is available (production with no secret set). */
export function sessionKey(env: Env = process.env): Uint8Array | null {
  const pick = (v: string | undefined, min: number) => {
    const t = v?.trim();
    return t && t.length >= min ? t : null;
  };
  let material = pick(env.CHECKRAIL_SESSION_SECRET, MIN_SESSION_SECRET) ?? pick(env.CHECKRAIL_SANDBOX_SECRET, MIN_SESSION_SECRET) ?? pick(env.CHECKRAIL_DATA_KEY, 24);
  if (!material && env.NODE_ENV !== "production") {
    const logins = `${env.CHECKRAIL_USERS ?? ""}|${basicAuthSetting(env) ?? ""}`;
    if (logins !== "|") material = `development:${logins}`;
  }
  // Domain separation: the same secret also signs the sandbox cookie or encrypts fields; this key is only for sessions.
  return material ? hmacSha256(enc.encode(material), enc.encode("checkrail-session-key-v1")) : null;
}

const sign = (user: string, pass: string, exp: string, key: Uint8Array) => base64url(hmacSha256(key, enc.encode(`checkrail-session:v1:${user}:${exp}:${base64url(sha256(enc.encode(pass)))}`)));

function b64urlEncode(s: string): string {
  return base64url(enc.encode(s));
}

function b64urlDecode(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function signSession(login: UserCredential, key: Uint8Array, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000 + SESSION_MAX_AGE).toString(36);
  return `${b64urlEncode(login.user)}.${exp}.${sign(login.user, login.pass, exp, key)}`;
}

/** The login a session cookie names, or null when it is malformed, expired, tampered with or for a login that no longer exists. */
export function verifySession(token: string | null | undefined, users: UserCredential[], key: Uint8Array | null, nowMs: number = Date.now()): UserCredential | null {
  if (!key || !token || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [u, exp, sig] = parts;
  const user = b64urlDecode(u);
  if (!user || !/^[a-z0-9]{1,10}$/.test(exp)) return null;
  const expMs = parseInt(exp, 36) * 1000;
  // Expired, or claiming a life longer than any cookie this server issues.
  if (expMs <= nowMs || expMs > nowMs + SESSION_MAX_AGE * 1000 + 60_000) return null;
  let hit: UserCredential | null = null;
  for (const login of users) {
    // Every login is signed and compared, so timing does not show which usernames exist.
    const ok = sameText(sign(login.user, login.pass, exp, key), sig) && login.user === user;
    if (ok && !hit) hit = login;
  }
  return hit;
}

/**
 * Where to go after signing in: a same-origin path, or "/". Anything that could leave the site (an absolute URL,
 * "//host", a backslash, a control character) or loop back into the sign-in is replaced by "/".
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 1024 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let u: URL;
  try {
    u = new URL(raw, "http://checkrail.invalid");
  } catch {
    return "/";
  }
  if (u.origin !== "http://checkrail.invalid") return "/";
  if (u.pathname === "/signin" || u.pathname.startsWith("/api/signin") || u.pathname.startsWith("/api/signout")) return "/";
  return u.pathname + u.search + u.hash;
}

/** The sign-in URL that returns to this path afterwards. */
export function signInUrl(next: string, error?: string): string {
  const q = new URLSearchParams();
  const n = safeNext(next);
  if (n !== "/") q.set("next", n);
  if (error) q.set("error", error);
  const s = q.toString();
  return s ? `/signin?${s}` : "/signin";
}

/**
 * The password check's throttle and logging, shared by Basic auth (middleware) and the sign-in form (route).
 *   "throttled": the address is over its limit (a correct password is spared only under CHECKRAIL_THROTTLE_SPARES_VALID=1,
 *                with one login and no real money).
 *   "wrong":     a password was offered and did not match; counted, and logged under CHECKRAIL_LOG_CLIENT_IP=1.
 *   "none":      nothing was offered (not a guess, not counted).
 *   "ok":        a matching login.
 */
export function gateAttempt(opts: { throttle: Throttle; ip: string; users: UserCredential[]; who: UserCredential | null; attempted: boolean; headers: Headers; env?: Env; nowMs?: number }): "ok" | "throttled" | "wrong" | "none" {
  const env = opts.env ?? process.env;
  const at = opts.nowMs ?? Date.now();
  const limited = overLimit(opts.throttle, opts.ip, FAIL_LIMIT, FAIL_WINDOW_MS, at, false);
  // Only for a login that is published anyway (the judging demo): a correct password gets in even when the address is
  // over its limit, so one visitor's typos, or a proxy address shared by everyone, cannot lock every judge out. Ignored
  // when real money can move or more than one account is configured, so it never switches the throttle off for a secret.
  const sparesValid = env.CHECKRAIL_THROTTLE_SPARES_VALID === "1" && opts.users.length === 1 && !realMoneyEnv(env);
  if (limited && !(opts.who && sparesValid)) return "throttled";
  if (opts.who) return "ok";
  if (!opts.attempted) return "none";
  overLimit(opts.throttle, opts.ip, FAIL_LIMIT, FAIL_WINDOW_MS, at);
  // Opt-in, off by default: one wrong password on the deployed service shows which header really carries the
  // visitor's address behind the host's proxies, so CHECKRAIL_CLIENT_IP_HEADER can be set from evidence (render.yaml).
  if (env.CHECKRAIL_LOG_CLIENT_IP === "1") {
    const h = opts.headers;
    console.warn("[checkrail] failed login", { key: opts.ip, xForwardedFor: h.get("x-forwarded-for"), cfConnectingIp: h.get("cf-connecting-ip"), trueClientIp: h.get("true-client-ip"), xRealIp: h.get("x-real-ip") });
  }
  return "wrong";
}

/** Whether a request is a browser asking for a page (redirect it to sign in) rather than a fetch, RSC or API call (401). */
export function wantsPage(method: string, h: Headers): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (h.get("rsc") || h.get("next-router-prefetch") || h.get("next-action")) return false;
  return (h.get("accept") ?? "").includes("text/html");
}

/** Whether a POST came from this site: its Origin names the host the request was sent to. */
export function sameOrigin(h: Headers, requestUrl: string): boolean {
  const origin = h.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}
