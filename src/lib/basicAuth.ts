/**
 * Optional HTTP Basic auth for the whole app. Active only when DUELINE_BASIC_AUTH=user:pass
 * is set. Pure functions so they can run in the Edge middleware and in tests.
 * This is a single shared credential, not RBAC: it gives each request a username
 * (used as the audit actor) and keeps strangers out.
 */

export const ACTOR_HEADER = "x-dueline-user";

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
