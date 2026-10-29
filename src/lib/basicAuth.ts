/**
 * HTTP Basic auth for the whole app, with named users and roles. Pure functions so they run in the Edge
 * middleware and in tests.
 *
 *  - CHECKRAIL_USERS="daniel:pw:admin,minh:pw:approver,lan:pw:clerk,thu:pw:accountant" gives each person a login
 *    and a role. The username is the audit actor; the role decides what they may do (src/lib/auth/roles.ts).
 *  - CHECKRAIL_BASIC_AUTH="user:pass" (the older single credential) still works and is an admin.
 */
import { isRole, type Role } from "./auth/roles";

export const ACTOR_HEADER = "x-checkrail-user";
export const ROLE_HEADER = "x-checkrail-role";
/** Set by the middleware when the role came from a demo persona rather than a login. */
export const PERSONA_HEADER = "x-checkrail-persona";
export const PERSONA_COOKIE = "checkrail_persona";

export type UserCredential = { user: string; pass: string; role: Role };

export const MIN_LIVE_PASSWORD = 12;

/** Real money can move: live PayPal, public Stellar or live Wise. The sandbox and testnet are not covered, on purpose. */
function realMoneyEnv(env: Record<string, string | undefined>): boolean {
  return env.PAYPAL_ENV === "live" || env.STELLAR_NETWORK === "public" || env.WISE_ENV === "live";
}

/**
 * Every configured login. Null when a setting is present but malformed: a malformed setting must refuse, not open.
 * Where real money can move, a password under MIN_LIVE_PASSWORD characters counts as malformed too: there is no
 * per-account lockout, so a short password on a public login is the weak point.
 */
export function configuredUsers(env: Record<string, string | undefined> = process.env): UserCredential[] | null {
  const out = configuredUsersUnchecked(env);
  if (out && realMoneyEnv(env) && out.some((u) => u.pass.length < MIN_LIVE_PASSWORD)) return null;
  return out;
}

function configuredUsersUnchecked(env: Record<string, string | undefined>): UserCredential[] | null {
  const out: UserCredential[] = [];
  const list = env.CHECKRAIL_USERS;
  if (list) {
    for (const entry of list.split(",").map((x) => x.trim()).filter(Boolean)) {
      const last = entry.lastIndexOf(":");
      const role = entry.slice(last + 1);
      const cred = parseCredential(entry.slice(0, last));
      if (last < 0 || !cred || !isRole(role)) return null;
      if (out.some((u) => u.user === cred.user)) return null;
      out.push({ ...cred, role });
    }
  }
  const single = basicAuthSetting(env);
  if (single) {
    const cred = parseCredential(single);
    if (!cred) return null;
    if (!out.some((u) => u.user === cred.user)) out.push({ ...cred, role: "admin" });
  }
  return out;
}

/** Check a Basic header against every configured login, comparing all of them so timing does not reveal which matched. */
export function authenticate(authorization: string | null | undefined, users: UserCredential[]): UserCredential | null {
  let hit: UserCredential | null = null;
  for (const u of users) {
    const ok = checkBasicAuth(authorization, `${u.user}:${u.pass}`);
    if (ok && !hit) hit = u;
  }
  return hit;
}

/**
 * The configured credential. DUELINE_BASIC_AUTH is the variable's name from before the
 * product was renamed: it is still honoured so an existing .env does not silently switch auth off.
 */
export function basicAuthSetting(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.CHECKRAIL_BASIC_AUTH || env.DUELINE_BASIC_AUTH || undefined;
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** Constant-time string comparison (no early exit on the first differing character). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Parse "user:pass". Returns null if unset or malformed (a malformed setting must not silently disable auth, see isConfigured). */
export function parseCredential(setting: string | undefined | null): { user: string; pass: string } | null {
  if (!setting) return null;
  const i = setting.indexOf(":");
  if (i < 1 || i === setting.length - 1) return null;
  const user = setting.slice(0, i);
  const pass = setting.slice(i + 1);
  return USERNAME_RE.test(user) ? { user, pass } : null;
}

/** Returns the authenticated username, or null if the Authorization header does not match. */
export function checkBasicAuth(authorization: string | null | undefined, setting: string): string | null {
  const cred = parseCredential(setting);
  if (!cred || !authorization || !/^Basic /i.test(authorization)) return null;
  let decoded: string;
  try {
    decoded = atob(authorization.slice(6).trim());
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  // Evaluate both comparisons so timing does not reveal which half was wrong.
  const userOk = safeEqual(user, cred.user);
  const passOk = safeEqual(pass, cred.pass);
  return userOk && passOk ? cred.user : null;
}

/**
 * Whether the "act as" demo switch is on: never when a live PayPal or public Stellar network is configured (even in
 * mock mode, to be safe), and only when asked for or when no logins exist (open development server).
 */
export function personasAllowed(env: Record<string, string | undefined> = process.env, loginsConfigured: boolean): boolean {
  if (env.PAYPAL_ENV === "live" || env.STELLAR_NETWORK === "public") return false;
  return env.CHECKRAIL_DEMO_PERSONAS === "1" || !loginsConfigured;
}
