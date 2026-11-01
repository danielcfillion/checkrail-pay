import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { and, desc, eq, inArray, ne, or, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { agentChecks, agentMandates, departureServices, departures, obligations, vendors } from "../db/schema";
import { bareKey, jobKeys, newId, now, sourceRefKeys } from "../domain/ids";
import { SUPPORTED_CURRENCIES, ZERO_DECIMAL_CURRENCIES } from "../domain/money";
import { subKey, usingDevKey } from "../crypto/dataKey";
import { formatMoney } from "../format";
import { AgentInputError } from "./errors";
import type { AgentKey } from "./keys";

/**
 * Signed spending mandates: the owner gives one agent a written, expiring, revocable allowance.
 *
 *   agent key name, allowed payees or supplier roles, per-payment cap, total cap, currency, an optional purpose
 *   ("departures": the payment is for a departure in the booking system that the supplier serves), valid from and until
 *
 * The agent presents the token on request_payment. Checkrail verifies the signature, the dates, that it is not
 * revoked, that this agent holds it, the payee, the currency, the per-payment cap and the purpose, and the budget left
 * (the agent's earlier requests under it that were not cancelled, in flight included). Out of scope is refused with the
 * reason and nothing is created. In scope, the request goes on to the normal rules and the owner's autonomy setting:
 * a mandate never approves anything, it only narrows what the agent may ask for.
 *
 * Signing: Ed25519, with a key pair derived (HKDF) from the app's data key (crypto/dataKey.ts subKey), not HMAC. The
 * point of a mandate is that an agent can carry it to someone else: a PayPal agent flow, an auditor, or a Soroban
 * contract. With HMAC only Checkrail could check it; with Ed25519 anyone with the public key can, and the key is an
 * ordinary Stellar account key (shown as G...), which a Soroban contract verifies natively (env.crypto().ed25519_verify).
 * The private key never leaves the server and is never stored: it is re-derived from CHECKRAIL_DATA_KEY when needed.
 *
 * Token: "crm1.<base64url payload JSON>.<base64url signature>", the signature over the ASCII bytes "crm1.<payload>".
 * Revocation and the budget live in the database, never in the token.
 *
 * On-chain later (contracts/spend-policy, not deployed): the same caps map onto the Soroban spend-policy contract.
 *   per-payment cap     -> per_payment_cap, checked at propose and again at release
 *   allowed payees      -> set_payee allow-list (one Stellar address per supplier on file)
 *   total cap           -> the contract's balance: the owner funds it with the mandate's total and no more (the
 *                          contract's daily_cap bounds the rate of spend inside it)
 *   valid until, revoke -> pause (owner or agent) and withdraw (owner); set_agent rotates the agent key
 *   the agent           -> the contract's agent address, the only key that may propose
 * Roles and the "departures" purpose stay off-chain: the chain cannot see the booking system.
 */

const TOKEN_PREFIX = "crm1";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const MAX_DAYS = 366;
export const MANDATE_PURPOSES = ["departures"] as const;
export type MandatePurpose = (typeof MANDATE_PURPOSES)[number];
export const PURPOSE_LABEL: Record<MandatePurpose, string> = { departures: "Departures in the booking system, to suppliers serving them" };

// ---------- Keys ----------

function signingKey(): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, subKey("agent-mandates/ed25519/v1")]), format: "der", type: "pkcs8" });
}

/**
 * Without CHECKRAIL_DATA_KEY the signing seed comes from the public development key in crypto/dataKey.ts, so anyone can
 * derive the private key and forge a mandate that verifies (review AF-3). Such keys and tokens say so wherever they
 * appear, and a production server refuses to issue with one.
 */
export const DEV_KEY_LABEL = "development key, not trustworthy outside this demo";
export const mandateKeyIsDevelopment = (): boolean => usingDevKey();

/** Checkrail's mandate public key: raw 32 bytes, base64url, and as a Stellar account key (G...). */
export function mandatePublicKey(): { raw: Buffer; base64url: string; stellar: string; key: KeyObject; development: boolean } {
  const key = createPublicKey(signingKey());
  const raw = (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return { raw, base64url: raw.toString("base64url"), stellar: stellarAccountId(raw), key, development: usingDevKey() };
}

/**
 * A raw Ed25519 public key as a Stellar account id (StrKey, version byte G): base32 of the version byte, the key and a
 * CRC16-XModem checksum. Written out here so the demo seed does not load the Stellar SDK; the test checks it against it.
 */
export function stellarAccountId(raw: Buffer): string {
  const body = Buffer.concat([Buffer.from([6 << 3]), raw]);
  let crc = 0;
  for (const byte of body) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const data = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** A verifier's copy of the public key from its raw 32 bytes (what anyone holding the published key would build). */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export interface MandatePayload {
  v: 1;
  id: string;
  iss: string; // business id
  agent: string;
  payees: Array<{ id: string; name: string }>;
  roles: string[];
  per_payment_minor: number;
  total_minor: number;
  currency: string;
  purpose: MandatePurpose | null;
  note: string | null;
  nbf: string;
  exp: string;
  iat: string;
  /** Present only when signed with the public development key: such a token proves nothing outside this demo. */
  signing_key?: typeof DEV_KEY_LABEL;
}

export function signMandate(payload: MandatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(null, Buffer.from(`${TOKEN_PREFIX}.${body}`, "ascii"), signingKey());
  return `${TOKEN_PREFIX}.${body}.${sig.toString("base64url")}`;
}

/**
 * The payload of a token whose signature verifies under `publicKey` (Checkrail's own by default), or the reason it
 * does not. Anyone can run this with the public key; it says nothing about revocation or budget.
 */
export function verifyMandateToken(token: string, publicKey: KeyObject = mandatePublicKey().key): { ok: true; payload: MandatePayload } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return { ok: false, reason: "this is not a Checkrail mandate" };
  const sig = Buffer.from(parts[2], "base64url");
  let good = false;
  try {
    good = sig.length === 64 && verify(null, Buffer.from(`${TOKEN_PREFIX}.${parts[1]}`, "ascii"), publicKey, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "the mandate's signature does not verify; it was not issued by this Checkrail or it was changed" };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as MandatePayload;
    if (payload?.v !== 1 || typeof payload.id !== "string") return { ok: false, reason: "this mandate's format is not one Checkrail reads" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "this mandate's format is not one Checkrail reads" };
  }
}

const tokenHash = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// ---------- Issue and revoke (the owner, from the Agents page) ----------

/** "1,000", "1000.50" or 1000 to minor units; owner input, so a clear error rather than a guess. */
function majorToMinor(v: unknown, name: string, currency: string): number {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  const m = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`${name} must be an amount such as 500 or 1,000.00`);
  const minor = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error(`${name} must be more than zero`);
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && minor % 100 !== 0) throw new Error(`${name} must be a whole number of ${currency}`);
  return minor;
}

export interface IssueInput {
  agent: unknown;
  payees?: unknown; // vendor ids
  roles?: unknown;
  perPayment: unknown;
  total: unknown;
  currency: unknown;
  purpose?: unknown;
  note?: unknown;
  validFrom?: unknown; // ISO or YYYY-MM-DD; default now
  validUntil: unknown; // ISO or YYYY-MM-DD (end of that day, UTC)
}

const isoOf = (v: unknown, name: string, endOfDay: boolean): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  const t = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T${endOfDay ? "23:59:59.000" : "00:00:00.000"}Z`) : new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} must be a date`);
  return d.toISOString();
};

/** Sign and record a mandate. The caller has checked the person may (the owner: the settings permission). */
export function issueMandate(db: Db, businessId: string, actor: string, input: IssueInput): typeof agentMandates.$inferSelect {
  // A production server with only the public development key would sign mandates anyone can forge (review AF-3).
  if (usingDevKey() && process.env.NODE_ENV === "production") throw new Error("Mandates cannot be issued on this server: CHECKRAIL_DATA_KEY is not set, so a mandate would be signed with the public development key and anyone could forge one. Set CHECKRAIL_DATA_KEY first.");
  const agent = typeof input.agent === "string" ? input.agent.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(agent)) throw new Error("Choose the agent key the mandate is for (its name, such as claude-desktop)");
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error(`Currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}`);
  const perPayment = majorToMinor(input.perPayment, "The per-payment cap", currency);
  const total = majorToMinor(input.total, "The total cap", currency);
  if (perPayment > total) throw new Error("The per-payment cap cannot be more than the total");
  const ids = Array.isArray(input.payees) ? [...new Set(input.payees.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
  const roles = Array.isArray(input.roles) ? [...new Set(input.roles.filter((x): x is string => typeof x === "string" && /^[a-z_]{2,20}$/.test(x)))] : [];
  if (ids.length === 0 && roles.length === 0) throw new Error("Allow at least one supplier or one kind of supplier");
  const payees = ids.length ? db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.businessId, businessId), inArray(vendors.id, ids))).all() : [];
  if (payees.length !== ids.length) throw new Error("A chosen supplier is not on file");
  const purpose = input.purpose === undefined || input.purpose === null || input.purpose === "" ? null : input.purpose;
  if (purpose !== null && !(MANDATE_PURPOSES as readonly unknown[]).includes(purpose)) throw new Error("Unknown purpose");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.replace(/\s+/g, " ").trim().slice(0, 160) : null;
  const nbf = input.validFrom ? isoOf(input.validFrom, "Valid from", false) : now();
  const exp = isoOf(input.validUntil, "Valid until", true);
  if (exp <= nbf) throw new Error("Valid until must be after valid from");
  if (Date.parse(exp) - Date.parse(nbf) > MAX_DAYS * 86_400_000) throw new Error("A mandate can last a year at most");
  const id = newId("mdt");
  const iat = now();
  const token = signMandate({ v: 1, id, iss: businessId, agent, payees, roles, per_payment_minor: perPayment, total_minor: total, currency, purpose: purpose as MandatePurpose | null, note, nbf, exp, iat, ...(usingDevKey() ? { signing_key: DEV_KEY_LABEL } : {}) });
  const row = { id, businessId, agent, payeesJson: JSON.stringify(payees.map((p) => p.id)), rolesJson: JSON.stringify(roles), perPaymentMinor: perPayment, totalMinor: total, currency, purpose: purpose as string | null, note, validFrom: nbf, validUntil: exp, token, tokenHash: tokenHash(token), issuedBy: actor, createdAt: iat, revokedAt: null, revokedBy: null };
  db.insert(agentMandates).values(row).run();
  return row;
}

export function revokeMandate(db: Db, businessId: string, id: string, actor: string): void {
  const row = db.select().from(agentMandates).where(and(eq(agentMandates.id, id), eq(agentMandates.businessId, businessId))).get();
  if (!row) throw new Error("No such mandate");
  if (row.revokedAt) return;
  db.update(agentMandates).set({ revokedAt: now(), revokedBy: actor }).where(eq(agentMandates.id, id)).run();
}

// ---------- Verify, scope and budget (request_payment) ----------

export type MandateRow = typeof agentMandates.$inferSelect;

/**
 * Request states that use a mandate's budget: on their way to being paid (waiting for evidence or a person, approved or
 * scheduled), being paid, paid, and blocked. A blocked request is reserved until it is cancelled: a person clearing it
 * (verifying the supplier, then a re-check) moves it on without the agent asking again, so leaving it out would let
 * several blocked requests all go through past the cap (review AF2-S1). Cancelled, failed and returned requests use
 * none of it; nor does a refusal. So the total cap is a true ceiling on what the agent can put in front of people.
 */
export const BUDGET_STATES = ["drafted", "needs_evidence", "verified", "awaiting_approval", "approved", "execution_pending", "sent", "settled", "disputed", "blocked"] as const;

/**
 * Used under a mandate: its requests in a budget state at their current amount (a person may have corrected it), and
 * those still being created at the amount asked. A request a person moved to another currency counts at the amount
 * the agent asked, in the mandate's currency.
 */
export function spentUnder(db: Db, mandateId: string): number {
  const cur = db.select({ c: agentMandates.currency }).from(agentMandates).where(eq(agentMandates.id, mandateId)).get()?.c ?? "";
  const r = db
    .select({ total: sql<number>`coalesce(sum(case when ${obligations.amountMinor} is not null and ${obligations.currency} = ${cur} then ${obligations.amountMinor} else ${agentChecks.amountMinor} end), 0)` })
    .from(agentChecks)
    .leftJoin(obligations, eq(obligations.id, agentChecks.obligationId))
    .where(and(eq(agentChecks.mandateId, mandateId), eq(agentChecks.tool, "request_payment"), ne(agentChecks.verdict, "refused"), or(isNull(agentChecks.obligationId), inArray(obligations.state, [...BUDGET_STATES]))))
    .get();
  return Number(r?.total ?? 0);
}

/**
 * For the request page: the mandate a request was made under, and whether its mandate is now over its cap (a person
 * raised an amount, or cleared a request a re-check moved on). Approval does not re-check the mandate: that would be a
 * money-path change, so a person reads this line before approving (review AF2 nit).
 */
export function mandateUseFor(db: Db, obligationId: string): { mandateId: string; agent: string; status: ReturnType<typeof statusOf>; currency: string; usedMinor: number; totalMinor: number; over: boolean } | null {
  const c = db.select({ m: agentChecks.mandateId }).from(agentChecks).where(and(eq(agentChecks.obligationId, obligationId), eq(agentChecks.tool, "request_payment"))).get();
  const row = c?.m ? db.select().from(agentMandates).where(eq(agentMandates.id, c.m)).get() : undefined;
  if (!row) return null;
  const used = spentUnder(db, row.id);
  return { mandateId: row.id, agent: row.agent, status: statusOf(row), currency: row.currency, usedMinor: used, totalMinor: row.totalMinor, over: used > row.totalMinor };
}

export function statusOf(row: MandateRow, at = now()): "active" | "not_yet_valid" | "expired" | "revoked" {
  if (row.revokedAt) return "revoked";
  if (at < row.validFrom) return "not_yet_valid";
  if (at >= row.validUntil) return "expired";
  return "active";
}

/** The mandate behind a token for this business, or the reason it cannot be used. Signature first, then the record. */
export function loadMandate(db: Db, businessId: string, token: string): { ok: true; row: MandateRow } | { ok: false; reason: string } {
  // Without the data key where one is required, no mandate can be checked: say so, not "could not complete" (AF2 nit).
  try {
    mandatePublicKey();
  } catch {
    return { ok: false, reason: "mandates cannot be checked on this server: CHECKRAIL_DATA_KEY is not set. Ask the owner" };
  }
  const v = verifyMandateToken(token);
  if (!v.ok) return v;
  const row = db.select().from(agentMandates).where(eq(agentMandates.id, v.payload.id)).get();
  if (!row || row.businessId !== businessId || v.payload.iss !== businessId || row.tokenHash !== tokenHash(token)) return { ok: false, reason: "this mandate is not on file for this business" };
  return { ok: true, row };
}

const PREFIX = "the mandate";

/**
 * Why this request is outside the mandate, or null. The budget is checked separately, in the same transaction that
 * records the request, so two requests at once cannot both fit in what is left.
 */
export function outOfScope(db: Db, row: MandateRow, agent: AgentKey, a: { amountMinor: number; currency: string; reference: string | null; description: string | null }, vendor: { id: string; name: string; role: string } | null): string | null {
  const st = statusOf(row);
  if (st === "revoked") return `${PREFIX} was revoked by the owner`;
  if (st === "expired") return `${PREFIX} expired on ${row.validUntil.slice(0, 10)}`;
  if (st === "not_yet_valid") return `${PREFIX} is valid only from ${row.validFrom.slice(0, 10)}`;
  if (row.agent !== agent.name) return `${PREFIX} was issued to another agent`;
  if (a.currency !== row.currency) return `${PREFIX} is for payments in ${row.currency}, not ${a.currency}`;
  const ids = JSON.parse(row.payeesJson) as string[];
  const roles = JSON.parse(row.rolesJson) as string[];
  if (!vendor || !(ids.includes(vendor.id) || roles.includes(vendor.role))) return `${PREFIX} does not cover this payee`;
  if (a.amountMinor > row.perPaymentMinor) return `${PREFIX} allows at most ${formatMoney(row.perPaymentMinor, row.currency, { code: true })} per payment; this asks for ${formatMoney(a.amountMinor, a.currency, { code: true })}`;
  if (row.purpose === "departures" && !servesDeparture(db, row.businessId, vendor.id, a.reference)) return `${PREFIX} covers departures in the booking system only, and this payment's reference is not a departure on file that this supplier serves`;
  return null;
}

/**
 * The payment's reference is a departure on file, and this supplier is on its services. Only the reference: free text
 * in the description is the agent's own word and could name any departure (review AF-11).
 */
function servesDeparture(db: Db, businessId: string, vendorId: string, reference: string | null): boolean {
  const named = new Set([...jobKeys(reference), ...sourceRefKeys(reference)].map(bareKey).filter((k) => k.length >= 3));
  if (named.size === 0) return false;
  const served = db.select({ code: departures.code }).from(departures).innerJoin(departureServices, eq(departureServices.departureId, departures.id)).where(and(eq(departures.businessId, businessId), eq(departureServices.vendorId, vendorId))).all();
  return served.some((d) => jobKeys(d.code).map(bareKey).some((k) => named.has(k)));
}

// ---------- mandate_status, and the owner's list ----------

export interface MandateView {
  id: string;
  agent: string;
  status: ReturnType<typeof statusOf>;
  currency: string;
  perPaymentMinor: number;
  totalMinor: number;
  spentMinor: number;
  remainingMinor: number;
  payees: string[];
  roles: string[];
  purpose: MandatePurpose | null;
  note: string | null;
  validFrom: string;
  validUntil: string;
  issuedBy: string;
  createdAt: string;
  revokedAt: string | null;
  token: string;
  requests: number;
  /** Signed with the public development key: proves nothing outside this demo. */
  development: boolean;
}

export function viewOf(db: Db, row: MandateRow): MandateView {
  const spent = spentUnder(db, row.id);
  const ids = JSON.parse(row.payeesJson) as string[];
  const names = ids.length ? db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, ids)).all() : [];
  const requests = db.select({ n: sql<number>`count(*)` }).from(agentChecks).where(and(eq(agentChecks.mandateId, row.id), eq(agentChecks.tool, "request_payment"))).get()?.n ?? 0;
  return {
    id: row.id,
    agent: row.agent,
    status: statusOf(row),
    currency: row.currency,
    perPaymentMinor: row.perPaymentMinor,
    totalMinor: row.totalMinor,
    spentMinor: spent,
    remainingMinor: Math.max(0, row.totalMinor - spent),
    payees: ids.map((id) => names.find((n) => n.id === id)?.name ?? "a supplier no longer on file"),
    roles: JSON.parse(row.rolesJson) as string[],
    purpose: (row.purpose as MandatePurpose | null) ?? null,
    note: row.note,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    issuedBy: row.issuedBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    token: row.token,
    requests: Number(requests),
    development: (() => {
      try {
        return (JSON.parse(Buffer.from(row.token.split(".")[1] ?? "", "base64url").toString("utf8")) as MandatePayload).signing_key === DEV_KEY_LABEL;
      } catch {
        return false;
      }
    })(),
  };
}

export function listMandates(db: Db, businessId: string, limit = 20): MandateView[] {
  return db.select().from(agentMandates).where(eq(agentMandates.businessId, businessId)).orderBy(desc(agentMandates.createdAt)).limit(limit).all().map((r) => viewOf(db, r));
}

const major = (minor: number, currency: string) => (ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

/** The mandate_status tool: what is left under a mandate this agent holds. Only the agent it was issued to may read it. */
export function mandateStatus(db: Db, agent: AgentKey, businessId: string, raw: unknown) {
  const t = (raw as Record<string, unknown> | null)?.mandate;
  if (typeof t !== "string" || !t.trim() || t.length > 4000) throw new AgentInputError("mandate is required: the token the owner gave this agent");
  const found = loadMandate(db, businessId, t.trim());
  if (!found.ok) throw new AgentInputError(`This mandate cannot be used: ${found.reason}.`);
  if (found.row.agent !== agent.name) throw new AgentInputError("This mandate was issued to another agent.");
  const v = viewOf(db, found.row);
  const pk = mandatePublicKey();
  return {
    mandate_id: v.id,
    status: v.status,
    currency: v.currency,
    per_payment: major(v.perPaymentMinor, v.currency),
    total: major(v.totalMinor, v.currency),
    used: major(v.spentMinor, v.currency),
    remaining: major(v.status === "active" ? v.remainingMinor : 0, v.currency),
    over_cap: v.spentMinor > v.totalMinor,
    summary:
      v.spentMinor > v.totalMinor
        ? `Over its cap: ${formatMoney(v.spentMinor, v.currency, { code: true })} committed of ${formatMoney(v.totalMinor, v.currency, { code: true })}, after a person changed or cleared a request. Nothing more may be requested under it.`
        : v.status === "active"
        ? `${formatMoney(v.remainingMinor, v.currency, { code: true })} left of ${formatMoney(v.totalMinor, v.currency, { code: true })}, at most ${formatMoney(v.perPaymentMinor, v.currency, { code: true })} per payment, until ${v.validUntil.slice(0, 10)}.`
        : v.status === "revoked" ? "Revoked by the owner. Nothing more may be requested under it."
        : v.status === "expired" ? `Expired on ${v.validUntil.slice(0, 10)}. Nothing more may be requested under it.`
        : `Valid from ${v.validFrom.slice(0, 10)}.`,
    payees: v.payees,
    roles: v.roles,
    purpose: v.purpose,
    valid_from: v.validFrom,
    valid_until: v.validUntil,
    signer_public_key: { ed25519_base64url: pk.base64url, stellar: pk.stellar, ...(pk.development ? { trust: DEV_KEY_LABEL } : {}) },
    note: "A mandate narrows what this agent may request. Every request under it still goes through the business's rules and approval; it never approves or sends a payment.",
  };
}
