import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db";
import { xeroConnections, xeroOauthStates } from "../db/schema";
import { config } from "../config";
import { decryptField, encryptField } from "../crypto/dataKey";
import { audit } from "../domain/stateMachine";

/**
 * Xero OAuth 2.0, authorization code flow (developer.xero.com/documentation/guides/oauth2/auth-flow).
 *
 *  - Authorize at login.xero.com, exchange and refresh at identity.xero.com with the client id and secret as Basic auth.
 *  - Access tokens last 30 minutes; refresh tokens 60 days and rotate on every refresh. The new refresh token is
 *    stored before anything else happens; the old one keeps working for a 30 minute grace period, which covers a
 *    crash between Xero's answer and the save.
 *  - Scopes: Xero assigned granular scopes to every web app from March 2026 (accounting.transactions is deprecated and
 *    new apps cannot ask for it), so the default asks for invoices, payments and bank transactions separately.
 *    XERO_SCOPES overrides the list for an older app that still has the broad scope.
 *
 * Tokens are encrypted with the data key and are never logged or sent to the browser.
 */

export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

export const DEFAULT_XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.payments",
  "accounting.banktransactions",
  "accounting.contacts",
  "accounting.settings.read",
].join(" ");

/** A "Connect to Xero" link is good for this long: enough to sign in to Xero and pick an organisation. */
export const STATE_TTL_MS = 10 * 60_000;
/** Refresh this long before the access token runs out, so a push never starts with a token about to expire. */
const REFRESH_MARGIN_MS = 2 * 60_000;

export function xeroScopes(): string {
  return (process.env.XERO_SCOPES || DEFAULT_XERO_SCOPES).trim().split(/\s+/).join(" ");
}

/** Where Xero sends the owner back: the public site address, else Render's, else the local dev server. Must match the Xero app exactly. */
export function xeroRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.NEXT_PUBLIC_SITE_URL || env.RENDER_EXTERNAL_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
  return `${base}/api/xero/callback`;
}

export function xeroConfigured(): boolean {
  return Boolean(config.accounting.xero.clientId && config.accounting.xero.clientSecret);
}

function basicAuth(): string {
  const { clientId, clientSecret } = config.accounting.xero;
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

const hashState = (state: string) => createHash("sha256").update(state).digest("hex");

/** Start a connection: a random state bound to this login, stored as a hash, and the Xero URL to send the browser to. */
export function beginXeroConnect(db: Db, opts: { businessId: string; login: string; actor: string; nowMs?: number }): { url: string; state: string } {
  const nowMs = opts.nowMs ?? Date.now();
  // Old, unused states go first: a table of abandoned sign-ins helps nobody.
  db.delete(xeroOauthStates).where(lt(xeroOauthStates.expiresAt, new Date(nowMs).toISOString())).run();
  const state = randomBytes(32).toString("base64url");
  db.insert(xeroOauthStates)
    .values({ stateHash: hashState(state), businessId: opts.businessId, login: opts.login, actor: opts.actor, expiresAt: new Date(nowMs + STATE_TTL_MS).toISOString(), createdAt: new Date(nowMs).toISOString() })
    .run();
  const q = new URLSearchParams({ response_type: "code", client_id: config.accounting.xero.clientId, redirect_uri: xeroRedirectUri(), scope: xeroScopes(), state });
  return { url: `${XERO_AUTHORIZE_URL}?${q.toString()}`, state };
}

export type StateCheck = { ok: true; businessId: string; actor: string } | { ok: false; reason: "missing" | "unknown" | "expired" | "other_login" };

/**
 * Use up a state from the callback. Single use whatever the outcome: a state seen once is deleted, so a replayed or
 * leaked callback URL does nothing. It must be unexpired and started by the same login that is finishing it.
 */
export function consumeXeroState(db: Db, state: string | null, login: string, nowMs = Date.now()): StateCheck {
  if (!state) return { ok: false, reason: "missing" };
  const h = hashState(state);
  const row = db.select().from(xeroOauthStates).where(eq(xeroOauthStates.stateHash, h)).get();
  if (!row) return { ok: false, reason: "unknown" };
  db.delete(xeroOauthStates).where(eq(xeroOauthStates.stateHash, h)).run();
  if (row.expiresAt <= new Date(nowMs).toISOString()) return { ok: false, reason: "expired" };
  if (row.login !== login) return { ok: false, reason: "other_login" };
  return { ok: true, businessId: row.businessId, actor: row.actor };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** A token call failed. `revoked` means the refresh token is no good any more: the owner has to connect again. */
export class XeroAuthError extends Error {
  constructor(message: string, readonly revoked = false) {
    super(message);
  }
}

async function tokenCall(body: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(XERO_TOKEN_URL, { method: "POST", headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(body).toString() });
  } catch {
    throw new XeroAuthError("Could not reach Xero to sign in. Try again in a minute.");
  }
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) {
    // invalid_grant: the code or refresh token was used, expired or revoked. Never echo the token itself.
    const revoked = json.error === "invalid_grant";
    throw new XeroAuthError(revoked ? "Xero no longer accepts this connection. Connect to Xero again from Settings." : `Xero sign-in failed (HTTP ${res.status}).`, revoked);
  }
  return json as TokenResponse;
}

export async function exchangeXeroCode(code: string): Promise<TokenResponse> {
  return tokenCall({ grant_type: "authorization_code", code, redirect_uri: xeroRedirectUri() });
}

/** The authentication_event_id in Xero's access token (a JWT), so the tenant picked in this sign-in is the one stored. */
export function authEventIdOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { authentication_event_id?: string };
    return payload.authentication_event_id ?? null;
  } catch {
    return null;
  }
}

export interface XeroTenant {
  id: string;
  tenantId: string;
  tenantType: string;
  tenantName: string | null;
  authEventId?: string;
}

export async function fetchXeroConnections(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!res.ok) throw new XeroAuthError(`Xero did not list the connected organisations (HTTP ${res.status}).`);
  return (await res.json()) as XeroTenant[];
}

/** The organisation chosen in this sign-in: the one tagged with this authentication event, else the first organisation. */
export function pickTenant(tenants: XeroTenant[], authEventId: string | null): XeroTenant | null {
  const orgs = tenants.filter((t) => t.tenantType === "ORGANISATION");
  return (authEventId ? orgs.find((t) => t.authEventId === authEventId) : undefined) ?? orgs[0] ?? null;
}

/** Finish the callback: exchange the code, find the organisation, store the tokens encrypted. Returns the tenant name. */
export async function completeXeroConnect(db: Db, opts: { businessId: string; actor: string; code: string; nowMs?: number }): Promise<{ tenantName: string | null }> {
  const tok = await exchangeXeroCode(opts.code);
  if (!tok.refresh_token) throw new XeroAuthError("Xero did not return a refresh token. The app must ask for offline_access.");
  const tenant = pickTenant(await fetchXeroConnections(tok.access_token), authEventIdOf(tok.access_token));
  if (!tenant) throw new XeroAuthError("No Xero organisation was connected. Pick an organisation on Xero's screen and try again.");
  const nowMs = opts.nowMs ?? Date.now();
  const ts = new Date(nowMs).toISOString();
  const prior = db.select().from(xeroConnections).where(eq(xeroConnections.businessId, opts.businessId)).get();
  // Reconnecting the same organisation keeps the account mapping; a different organisation starts clean.
  const keepMapping = prior && prior.tenantId === tenant.tenantId;
  const values = {
    businessId: opts.businessId,
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    connectionId: tenant.id,
    accessTokenEnc: encryptField(tok.access_token),
    refreshTokenEnc: encryptField(tok.refresh_token),
    accessExpiresAt: new Date(nowMs + tok.expires_in * 1000).toISOString(),
    scopes: tok.scope ?? xeroScopes(),
    status: "connected",
    connectedBy: opts.actor,
    connectedAt: ts,
    expenseAccountCode: keepMapping ? prior.expenseAccountCode : null,
    paypalAccountCode: keepMapping ? prior.paypalAccountCode : null,
    stellarAccountCode: keepMapping ? prior.stellarAccountCode : null,
    bankAccountCode: keepMapping ? prior.bankAccountCode : null,
    feeAccountCode: keepMapping ? prior.feeAccountCode : null,
    taxType: keepMapping ? prior.taxType : null,
    chartJson: keepMapping ? prior.chartJson : null,
    chartFetchedAt: keepMapping ? prior.chartFetchedAt : null,
    blockedUntil: null,
    lastPushAt: keepMapping ? prior.lastPushAt : null,
    lastError: null,
    updatedAt: ts,
  };
  db.insert(xeroConnections).values(values).onConflictDoUpdate({ target: xeroConnections.businessId, set: values }).run();
  audit(db, { obligationId: null, actor: opts.actor, action: "xero.connected", detail: { tenant: tenant.tenantName ?? tenant.tenantId } });
  return { tenantName: tenant.tenantName };
}

export type XeroConnectionRow = typeof xeroConnections.$inferSelect;

export function getXeroConnection(db: Db, businessId: string): XeroConnectionRow | null {
  return db.select().from(xeroConnections).where(eq(xeroConnections.businessId, businessId)).get() ?? null;
}

/** One refresh at a time per business: two at once would each rotate the token and one would lose. */
const refreshing = new Map<string, Promise<string>>();

/** Refresh now, store both new tokens, return the new access token. */
export function refreshXeroToken(db: Db, businessId: string): Promise<string> {
  const running = refreshing.get(businessId);
  if (running) return running;
  const p = (async () => {
    const conn = getXeroConnection(db, businessId);
    if (!conn) throw new XeroAuthError("Xero is not connected.");
    try {
      const tok = await tokenCall({ grant_type: "refresh_token", refresh_token: decryptField(conn.refreshTokenEnc) });
      const ts = new Date().toISOString();
      db.update(xeroConnections)
        .set({
          accessTokenEnc: encryptField(tok.access_token),
          // Rotation: the new refresh token replaces the old one at once. Keep the old one only if Xero sent none.
          refreshTokenEnc: tok.refresh_token ? encryptField(tok.refresh_token) : conn.refreshTokenEnc,
          accessExpiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
          status: "connected",
          updatedAt: ts,
        })
        .where(and(eq(xeroConnections.businessId, businessId), eq(xeroConnections.tenantId, conn.tenantId)))
        .run();
      return tok.access_token;
    } catch (e) {
      if (e instanceof XeroAuthError && e.revoked) {
        db.update(xeroConnections).set({ status: "needs_reconnect", lastError: e.message, updatedAt: new Date().toISOString() }).where(eq(xeroConnections.businessId, businessId)).run();
      }
      throw e;
    }
  })().finally(() => refreshing.delete(businessId));
  refreshing.set(businessId, p);
  return p;
}

/** A usable access token: the stored one while it has more than two minutes left, else a fresh one. */
export async function xeroAccessToken(db: Db, businessId: string, nowMs = Date.now()): Promise<string> {
  const conn = getXeroConnection(db, businessId);
  if (!conn) throw new XeroAuthError("Xero is not connected.");
  if (conn.status === "needs_reconnect") throw new XeroAuthError(conn.lastError ?? "Connect to Xero again from Settings.", true);
  if (Date.parse(conn.accessExpiresAt) - nowMs > REFRESH_MARGIN_MS) return decryptField(conn.accessTokenEnc);
  return refreshXeroToken(db, businessId);
}

/**
 * Disconnect: remove the connection at Xero (DELETE /connections/{id}), then wipe the tokens and tenant here. The
 * local wipe happens whatever Xero says, so a failed call never leaves a token behind. Sync records stay: they say
 * what is already in that organisation, should it be connected again.
 */
export async function disconnectXero(db: Db, businessId: string, actor: string): Promise<{ remote: "removed" | "failed" | "skipped" }> {
  const conn = getXeroConnection(db, businessId);
  if (!conn) return { remote: "skipped" };
  let remote: "removed" | "failed" | "skipped" = "skipped";
  if (conn.connectionId && conn.status === "connected") {
    try {
      const token = await xeroAccessToken(db, businessId);
      const res = await fetch(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(conn.connectionId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      remote = res.ok || res.status === 404 ? "removed" : "failed";
    } catch {
      remote = "failed";
    }
  }
  db.delete(xeroConnections).where(eq(xeroConnections.businessId, businessId)).run();
  db.delete(xeroOauthStates).where(eq(xeroOauthStates.businessId, businessId)).run();
  audit(db, { obligationId: null, actor, action: "xero.disconnected", detail: { tenant: conn.tenantName ?? conn.tenantId, remote } });
  return { remote };
}
