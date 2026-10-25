import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { businesses, obligations, settlements, vendorLinks, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { fmt } from "../domain/policy";
import { formatDate, railLabel } from "../format";
import { requirePermission, type Actor } from "./users";
import { uploadDocument } from "./attachments";
import { addEvidence } from "./orchestrator";

/**
 * Talking to vendors without the chat thread: a remittance advice they can open (what was paid, when, how, and the
 * provider's reference), and an evidence request where they upload the missing job sheet or receipt themselves.
 * Links carry a random token; only its hash is stored. Each link is for one payment.
 */

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const DAYS = { remittance: 90, evidence: 14 } as const;

function create(db: Db, businessId: string, by: Actor, kind: "remittance" | "evidence", obligationId: string, note: string | null): string {
  const ob = db.select().from(obligations).where(and(eq(obligations.id, obligationId), eq(obligations.businessId, businessId))).get();
  if (!ob || !ob.vendorId) throw new Error("No such payment, or it has no vendor yet");
  if (kind === "remittance" && ob.state !== "settled" && ob.state !== "sent") throw new Error("A remittance advice is for a payment that has been sent");
  if (kind === "evidence" && !["needs_evidence", "blocked", "awaiting_approval", "drafted"].includes(ob.state)) throw new Error("This payment is not waiting for evidence");
  const token = randomBytes(24).toString("base64url");
  db.insert(vendorLinks).values({ id: newId("vln"), businessId, kind, tokenHash: hash(token), obligationId, vendorId: ob.vendorId, note: note?.slice(0, 300) ?? null, expiresAt: new Date(Date.now() + DAYS[kind] * 86_400_000).toISOString(), createdBy: by.id, createdAt: now() }).run();
  audit(db, { obligationId, actor: by.id, action: kind === "remittance" ? "vendor.remittance_link" : "vendor.evidence_requested", detail: { note } });
  return token;
}

export function createRemittanceLink(db: Db, businessId: string, by: Actor, obligationId: string): string {
  requirePermission(by, "pay", "send remittance advice");
  return create(db, businessId, by, "remittance", obligationId, null);
}

export function createEvidenceRequest(db: Db, businessId: string, by: Actor, obligationId: string, note: string | null): string {
  requirePermission(by, "amend", "ask vendors for evidence");
  return create(db, businessId, by, "evidence", obligationId, note);
}

function find(db: Db, token: string, kind: "remittance" | "evidence") {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const l = db.select().from(vendorLinks).where(and(eq(vendorLinks.tokenHash, hash(token)), eq(vendorLinks.kind, kind))).get();
  if (!l || l.expiresAt <= now()) return null;
  return l;
}

export interface Remittance {
  businessName: string;
  vendorName: string;
  reference: string;
  amount: string;
  received: string | null;
  rail: string;
  date: string;
  providerRef: string | null;
  status: "paid" | "on its way";
  language: "en" | "vi";
}

export function viewRemittance(db: Db, token: string): Remittance | null {
  const l = find(db, token, "remittance");
  if (!l) return null;
  const ob = db.select().from(obligations).where(eq(obligations.id, l.obligationId)).get();
  const v = db.select().from(vendors).where(eq(vendors.id, l.vendorId)).get();
  const biz = db.select().from(businesses).where(eq(businesses.id, l.businessId)).get();
  if (!ob || !v || !biz) return null;
  const st = db.select().from(settlements).where(eq(settlements.obligationId, ob.id)).get();
  return {
    businessName: biz.name,
    vendorName: v.name,
    reference: ob.sourceRef ?? ob.id,
    amount: fmt(ob.amountMinor ?? 0, ob.currency ?? "USD"),
    received: st?.receivedMinor != null && st.receivedCurrency ? fmt(st.receivedMinor, st.receivedCurrency) : null,
    rail: railLabel(st?.rail ?? ob.selectedRail),
    date: formatDate(st?.settledAt ?? ob.updatedAt),
    providerRef: st?.externalId ?? null,
    status: ob.state === "settled" ? "paid" : "on its way",
    language: v.country === "VN" ? "vi" : "en",
  };
}

/** The message to paste into Zalo, WhatsApp or email alongside the link. Vietnamese for Vietnamese vendors. */
export function remittanceMessage(r: Remittance, url: string): string {
  if (r.language === "vi")
    return `Chào ${r.vendorName}, ${r.businessName} đã ${r.status === "paid" ? "thanh toán" : "chuyển"} ${r.amount} cho ${r.reference} qua ${r.rail} ngày ${r.date}${r.providerRef ? ` (mã giao dịch ${r.providerRef})` : ""}. Chi tiết: ${url}`;
  return `Hi ${r.vendorName}, ${r.businessName} ${r.status === "paid" ? "has paid" : "has sent"} ${r.amount} for ${r.reference} by ${r.rail} on ${r.date}${r.providerRef ? ` (reference ${r.providerRef})` : ""}. Details: ${url}`;
}

export interface EvidenceRequestView {
  businessName: string;
  vendorName: string;
  reference: string;
  amount: string;
  needed: string[];
  note: string | null;
  used: boolean;
}

export function viewEvidenceRequest(db: Db, token: string): EvidenceRequestView | null {
  const l = find(db, token, "evidence");
  if (!l) return null;
  const ob = db.select().from(obligations).where(eq(obligations.id, l.obligationId)).get();
  const v = db.select().from(vendors).where(eq(vendors.id, l.vendorId)).get();
  const biz = db.select().from(businesses).where(eq(businesses.id, l.businessId)).get();
  if (!ob || !v || !biz) return null;
  const missing = JSON.parse(ob.aiMissingJson ?? "[]") as string[];
  return { businessName: biz.name, vendorName: v.name, reference: ob.sourceRef ?? "your invoice", amount: fmt(ob.amountMinor ?? 0, ob.currency ?? "USD"), needed: missing.length ? missing : ["the invoice, job sheet or receipt for this payment"], note: l.note, used: Boolean(l.usedAt) };
}

/** The vendor's upload: the link is spent first, then the file is read and added to the payment as the vendor's own record. */
export async function submitEvidence(db: Db, token: string, file: { name: string; mimeType: string; bytes: Buffer }): Promise<void> {
  const l = find(db, token, "evidence");
  if (!l) throw new Error("This link is not valid or has expired.");
  const spent = db.update(vendorLinks).set({ usedAt: now() }).where(and(eq(vendorLinks.id, l.id), isNull(vendorLinks.usedAt))).run();
  if (spent.changes !== 1) throw new Error("This link has already been used. Ask for a new one if you need to send another document.");
  const actor = `vendor:evidence:${l.id}`;
  const up = await uploadDocument(db, { businessId: l.businessId, name: file.name, mimeType: file.mimeType, bytes: file.bytes, actor });
  const p = up.proposed[0];
  await addEvidence(db, l.obligationId, actor, { kind: p?.kind && ["invoice", "job_sheet", "receipt", "booking", "contract", "purchase_order"].includes(p.kind) ? p.kind : "receipt", label: `${p?.label ?? file.name} (from the vendor)`, amountMinor: p?.amountMinor ?? null, currency: p?.currency ?? null, reference: p?.reference ?? null, excerpt: p?.excerpt ?? null, provenance: "vendor" }, up.attachmentId);
}
