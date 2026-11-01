import type { Db } from "../db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "../basicAuth";
import { isRole, type Permission } from "../auth/roles";
import { actorCan, resolveActor, type Actor } from "../engine/users";
import { getBusiness } from "../queries";
import { config } from "../config";
import { beginXeroConnect, completeXeroConnect, consumeXeroState, disconnectXero, getXeroConnection, xeroConfigured, XeroAuthError } from "./xeroAuth";
import { refreshXeroChart, saveXeroMapping, type XeroMappingInput } from "./xeroSettings";
import { runXeroSync } from "./xeroSync";
import { XeroApiError } from "./xeroClient";

/**
 * The /api/xero/* routes, as plain functions of (request, database) so tests run them without a server. Each one
 * checks the login the middleware put on the request (it strips any copy a client sends): connecting, the mapping and
 * disconnecting need the settings permission (the owner); "Push to Xero" needs export, which the accountant has.
 * Writes accept JSON only, which a cross-site form cannot send.
 */

interface Who {
  actor: Actor;
  login: string;
  businessId: string;
}

export function whoFromRequest(req: Request, db: Db): Who | null {
  const username = req.headers.get(ACTOR_HEADER);
  const role = req.headers.get(ROLE_HEADER);
  if (!username || !isRole(role)) return null;
  const biz = getBusiness(db);
  if (!biz) return null;
  const persona = req.headers.get(PERSONA_HEADER) ?? undefined;
  return { actor: resolveActor(db, biz.id, username, role, persona), login: persona ?? username, businessId: biz.id };
}

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function allowed(req: Request, db: Db, p: Permission): Who | Response {
  const who = whoFromRequest(req, db);
  if (!who) return text("Sign in first.", 401);
  if (!actorCan(who.actor, p)) return text(p === "export" ? "Your role cannot send records to Xero." : "Only the owner can change the Xero connection.", 403);
  return who;
}

function jsonOnly(req: Request): Response | null {
  return /^application\/json\b/i.test(req.headers.get("content-type") ?? "") ? null : text("Send JSON.", 415);
}

/** Back to the Xero card on Settings, on the public address Xero also uses. */
function backToSettings(req: Request, outcome: string): Response {
  const base = process.env.NEXT_PUBLIC_SITE_URL || process.env.RENDER_EXTERNAL_URL || new URL(req.url).origin;
  return new Response(null, { status: 303, headers: { Location: `${base.replace(/\/+$/, "")}/settings?xero=${encodeURIComponent(outcome)}#xero`, "Cache-Control": "no-store" } });
}

/** GET /api/xero/connect: a fresh state bound to this login, then off to Xero. */
export function handleXeroConnect(req: Request, db: Db): Response {
  const who = allowed(req, db, "settings");
  if (who instanceof Response) return who;
  if (!xeroConfigured()) return backToSettings(req, "not_configured");
  const { url } = beginXeroConnect(db, { businessId: who.businessId, login: who.login, actor: who.actor.id });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
}

/** GET /api/xero/callback: check the state, exchange the code, find the organisation, keep the tokens encrypted. */
export async function handleXeroCallback(req: Request, db: Db): Promise<Response> {
  const who = allowed(req, db, "settings");
  if (who instanceof Response) return who;
  const q = new URL(req.url).searchParams;
  const state = consumeXeroState(db, q.get("state"), who.login);
  if (!state.ok) return backToSettings(req, state.reason === "expired" ? "expired" : "invalid_state");
  if (state.businessId !== who.businessId) return backToSettings(req, "invalid_state");
  if (q.get("error")) return backToSettings(req, "denied");
  const code = q.get("code");
  if (!code) return backToSettings(req, "invalid_state");
  try {
    await completeXeroConnect(db, { businessId: who.businessId, actor: who.actor.id, code });
  } catch (e) {
    // Server side only, and never a token: why the exchange failed (Xero's error code and status, or our own sentence).
    console.warn("[xero] connect failed:", (e as Error).message, e instanceof XeroAuthError && e.detail ? `(${e.detail})` : "");
    return backToSettings(req, "failed");
  }
  // The chart of accounts, so the mapping can be chosen straight away. Not fatal: the card has a button for it.
  await refreshXeroChart(db, who.businessId).catch(() => undefined);
  return backToSettings(req, "connected");
}

/** DELETE /api/xero/connection: remove the connection at Xero and wipe it here. */
export async function handleXeroDisconnect(req: Request, db: Db): Promise<Response> {
  const who = allowed(req, db, "settings");
  if (who instanceof Response) return who;
  if (!getXeroConnection(db, who.businessId)) return json({ ok: true, message: "Xero was not connected." });
  const r = await disconnectXero(db, who.businessId, who.actor.id);
  const message =
    r.remote === "failed"
      ? "Disconnected here. Xero did not confirm, so also remove Checkrail Pay under Connected apps in Xero."
      : r.remote === "expired"
        ? "Disconnected here. The Xero sign-in had already expired, so Xero could not be told: remove Checkrail Pay under Connected apps in Xero."
        : "Disconnected from Xero.";
  return json({ ok: true, message });
}

/** POST /api/xero/accounts: read the chart of accounts again. */
export async function handleXeroAccounts(req: Request, db: Db): Promise<Response> {
  const who = allowed(req, db, "settings");
  if (who instanceof Response) return who;
  const bad = jsonOnly(req);
  if (bad) return bad;
  if (!getXeroConnection(db, who.businessId)) return json({ ok: false, message: "Connect to Xero first." }, 409);
  try {
    const chart = await refreshXeroChart(db, who.businessId);
    return json({ ok: true, message: `Read ${chart.accounts.length} accounts from Xero.` });
  } catch (e) {
    return json({ ok: false, message: e instanceof XeroApiError ? e.message : "Could not read the chart of accounts." }, 502);
  }
}

/** POST /api/xero/mapping: which accounts bills, payments and fees post to. */
export async function handleXeroMapping(req: Request, db: Db): Promise<Response> {
  const who = allowed(req, db, "settings");
  if (who instanceof Response) return who;
  const bad = jsonOnly(req);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as Partial<Record<keyof XeroMappingInput, unknown>> | null;
  if (!body || typeof body !== "object") return json({ ok: false, message: "Send the mapping as JSON." }, 400);
  const pick = (k: keyof XeroMappingInput) => (typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim().slice(0, 40) : null);
  const r = saveXeroMapping(db, who.businessId, who.actor.id, {
    expenseAccountCode: pick("expenseAccountCode"),
    paypalAccountCode: pick("paypalAccountCode"),
    stellarAccountCode: pick("stellarAccountCode"),
    bankAccountCode: pick("bankAccountCode"),
    feeAccountCode: pick("feeAccountCode"),
    taxType: pick("taxType"),
  });
  return r.ok ? json({ ok: true, message: "Account mapping saved." }) : json(r, 400);
}

/** POST /api/xero/push: send what is waiting now, failures included. Never touches a payment. */
export async function handleXeroPush(req: Request, db: Db): Promise<Response> {
  const who = allowed(req, db, "export");
  if (who instanceof Response) return who;
  const bad = jsonOnly(req);
  if (bad) return bad;
  if (config.accounting.destination !== "xero") return json({ ok: false, message: "Set ACCOUNTING_DESTINATION=xero to send records to Xero." }, 409);
  if (!getXeroConnection(db, who.businessId)) return json({ ok: false, message: "Connect to Xero first." }, 409);
  let r;
  try {
    r = await runXeroSync(db, { businessId: who.businessId, force: true });
  } catch (e) {
    console.error("[xero] push failed:", (e as Error).message);
    return json({ ok: false, message: "Sending to Xero failed on an unexpected error. It will be tried again." }, 502);
  }
  if (r.skipped === "needs_reconnect") return json({ ok: false, message: r.errors[0] ?? "Connect to Xero again." }, 409);
  if (r.skipped === "busy") return json({ ok: false, message: r.errors[0] }, 409);
  if (r.errors.length && r.failed && !r.pushed && r.errors[0].startsWith("Could not read the chart")) return json({ ok: false, message: r.errors[0] }, 502);
  const parts = [r.pushed ? `${r.pushed} sent to Xero` : "Nothing new to send", r.failed ? `${r.failed} could not be sent` : null, r.rateLimited ? "the rest goes in a minute" : null].filter(Boolean);
  return json({ ok: r.failed === 0, message: `${parts.join(", ")}.`, result: r });
}
