import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { users, vendorChanges, vendorInvites, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { can, isRole } from "../auth/roles";
import { requirePermission, type Actor } from "./users";
import { payoutHashOf } from "./orchestrator";
import { RAILS, type Rail } from "../domain/types";
import { decryptField, encryptField, lastFour } from "../crypto/dataKey";
import { TAX_FORMS } from "./taxes";

/**
 * The vendor master: who the business pays and where the money lands.
 *
 * Payout details never change in place. A new vendor's details, or new details for an existing vendor, are a
 * proposal until a second person checks them by a stated method (a call back on a number already on file, a
 * small test payment, in person, or a document). Until then the vendor cannot be paid at the new details: the
 * existing details keep working, and a brand-new vendor is blocked by policy as unverified. This is the control
 * that stops the most common supplier fraud, a forged "our bank details have changed" email.
 */

export const VENDOR_ROLES = ["guide", "driver", "homestay", "hotel", "creator", "supplier", "contractor"] as const;
export const VENDOR_COUNTRIES = ["US", "PH", "VN", "CA", "GB", "TH"] as const;
export const VERIFY_METHODS = ["callback", "penny_test", "in_person", "document"] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];
export const VERIFY_METHOD_LABEL: Record<VerifyMethod, string> = {
  callback: "Called them back on a number already on file",
  penny_test: "Small test payment, amount confirmed by the vendor",
  in_person: "Confirmed in person",
  document: "Checked against a bank letter or statement",
};

const INVITE_DAYS = 7;

export interface VendorProfileInput {
  name: string;
  role: string;
  country: string;
  email?: string | null;
  notes?: string | null;
  defaultAccountCode?: string | null;
  taxType?: string | null;
  taxForm?: string | null;
  withholdingBps?: number | null;
}

export interface PayoutInput {
  preferredRail?: Rail | null;
  paypalEmail?: string | null;
  stellarAccount?: string | null;
  bankCountry?: string | null;
  bankCurrency?: string | null;
  bankLabel?: string | null;
  /** Plain account number as typed. Never stored: validatePayout encrypts it into bankAccountEnc. */
  bankAccountNumber?: string | null;
  bankAccountEnc?: string | null;
  bankCode?: string | null;
  accountHolder?: string | null;
}

/** Payout details as stored on a vendor (and in a pending change): the account number only ever encrypted. */
export type StoredPayout = { preferredRail: Rail | null; paypalEmail: string | null; stellarAccount: string | null; bankCountry: string | null; bankCurrency: string | null; bankLabel: string | null; bankAccountEnc: string | null; bankCode: string | null; accountHolder: string | null };

const EMAIL = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const STELLAR = /^G[A-Z2-7]{55}$/;

const str = (v: unknown, field: string, max: number, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new Error(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${field} must be at most ${max} characters`);
  // No control characters: these values are shown on screen and written to exports.
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new Error(`${field} contains control characters`);
  return t;
};

export function validateProfile(raw: unknown): Required<VendorProfileInput> {
  if (typeof raw !== "object" || raw === null) throw new Error("Vendor details must be an object");
  const r = raw as Record<string, unknown>;
  const name = str(r.name, "Name", 80, true)!;
  const role = str(r.role, "Role", 20, true)!;
  if (!(VENDOR_ROLES as readonly string[]).includes(role)) throw new Error(`Role must be one of: ${VENDOR_ROLES.join(", ")}`);
  const country = (str(r.country, "Country", 2, true) ?? "").toUpperCase();
  if (!(VENDOR_COUNTRIES as readonly string[]).includes(country)) throw new Error(`Country must be one of: ${VENDOR_COUNTRIES.join(", ")}`);
  const email = str(r.email, "Email", 254);
  if (email && !EMAIL.test(email)) throw new Error("Email does not look like an email address");
  const notes = str(r.notes, "Notes", 500);
  const defaultAccountCode = str(r.defaultAccountCode, "Account code", 20);
  if (defaultAccountCode && !/^[A-Za-z0-9.-]+$/.test(defaultAccountCode)) throw new Error("Account code may use letters, digits, dots and dashes");
  const taxType = r.taxType === "individual" || r.taxType === "business" ? r.taxType : null;
  if (r.taxType && !taxType) throw new Error("Tax type must be individual or business");
  const taxForm = (TAX_FORMS as readonly unknown[]).includes(r.taxForm) ? (r.taxForm as string) : null;
  if (r.taxForm && !taxForm) throw new Error(`Tax form must be one of: ${TAX_FORMS.join(", ")}`);
  const withholdingBps = r.withholdingBps === undefined || r.withholdingBps === null || r.withholdingBps === "" ? null : Number(r.withholdingBps);
  if (withholdingBps !== null && !(Number.isInteger(withholdingBps) && withholdingBps >= 0 && withholdingBps <= 3_000)) throw new Error("Withholding rate must be 0% to 30%");
  return { name, role, country, email, notes, defaultAccountCode, taxType, taxForm, withholdingBps };
}

/**
 * Check payout details and put them in stored form. A typed account number is encrypted here and nowhere else; an
 * already-encrypted one is accepted only from our own storage (fromStore), never from a form or a vendor's link.
 */
export function validatePayout(raw: unknown, opts: { fromStore?: boolean } = {}): StoredPayout {
  if (typeof raw !== "object" || raw === null) throw new Error("Payout details must be an object");
  const r = raw as Record<string, unknown>;
  const paypalEmail = str(r.paypalEmail, "PayPal email", 254)?.toLowerCase() ?? null;
  if (paypalEmail && !EMAIL.test(paypalEmail)) throw new Error("PayPal email does not look like an email address");
  const stellarAccount = str(r.stellarAccount, "Stellar account", 56)?.toUpperCase() ?? null;
  if (stellarAccount && !STELLAR.test(stellarAccount)) throw new Error("Stellar account must be a public key: G followed by 55 letters and digits");
  let bankLabel = str(r.bankLabel, "Bank account label", 40);
  // The label is for screens ("BDO ****1234"); a full number belongs in the account number field, which is encrypted.
  if (bankLabel && /\d{5,}/.test(bankLabel.replace(/[\s-]/g, ""))) throw new Error("Enter the bank label masked, like BDO ****1234; put the full number in the account number field");
  const bankCountry = str(r.bankCountry, "Bank country", 2)?.toUpperCase() ?? null;
  const bankCurrency = str(r.bankCurrency, "Bank currency", 3)?.toUpperCase() ?? null;
  const bankCode = str(r.bankCode, "Bank code", 11)?.toUpperCase() ?? null;
  if (bankCode && !/^[A-Z0-9]{2,11}$/.test(bankCode)) throw new Error("Bank code is the bank's short code or SWIFT code, letters and digits");
  const accountHolder = str(r.accountHolder, "Account holder", 70);
  let bankAccountEnc: string | null = null;
  let typed = str(r.bankAccountNumber, "Account number", 34);
  if (typed) {
    typed = typed.replace(/[\s-]/g, "");
    if (!/^\d{6,20}$/.test(typed)) throw new Error("Account number must be 6 to 20 digits");
    bankAccountEnc = encryptField(typed);
  } else if (opts.fromStore && typeof r.bankAccountEnc === "string") {
    decryptField(r.bankAccountEnc); // refuses anything not encrypted with this key
    bankAccountEnc = r.bankAccountEnc;
    typed = null;
  }
  if (bankAccountEnc) {
    if (!bankCode || !accountHolder) throw new Error("A bank account number needs the bank code and the account holder's name");
    if (!bankLabel) bankLabel = `${bankCode} ${lastFour(typed ?? decryptField(bankAccountEnc))}`;
  }
  if (bankLabel && (!bankCountry || !bankCurrency)) throw new Error("A bank account needs its country and currency");
  if (bankCurrency && !/^[A-Z]{3}$/.test(bankCurrency)) throw new Error("Bank currency must be a 3-letter code");
  const preferredRail = (RAILS as readonly unknown[]).includes(r.preferredRail) ? (r.preferredRail as Rail) : null;
  if (r.preferredRail && !preferredRail) throw new Error(`Preferred rail must be one of: ${RAILS.join(", ")}`);
  if (!paypalEmail && !stellarAccount && !bankLabel) throw new Error("Give at least one way to pay this vendor");
  if (preferredRail === "paypal" && !paypalEmail) throw new Error("Preferred rail is PayPal but no PayPal email is given");
  if (preferredRail === "stellar" && !stellarAccount) throw new Error("Preferred rail is Stellar but no Stellar account is given");
  if ((preferredRail === "wise" || preferredRail === "bank_file") && !bankAccountEnc) throw new Error("Preferred rail pays a bank account, but no account number is given");
  return { preferredRail, paypalEmail, stellarAccount, bankCountry, bankCurrency, bankLabel: bankLabel ?? null, bankAccountEnc, bankCode, accountHolder };
}

/** Add a vendor. Their payout details are on file but unverified, so policy blocks any payment until someone else verifies them. */
export function createVendor(db: Db, businessId: string, by: Actor, profileRaw: unknown, payoutRaw: unknown): string {
  requirePermission(by, "edit_vendor", "add vendors");
  const profile = validateProfile(profileRaw);
  const payout = validatePayout(payoutRaw);
  const clash = db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.businessId, businessId), eq(vendors.name, profile.name))).get();
  if (clash) throw new Error("A vendor with this name already exists; open it instead");
  const id = newId("ven");
  db.transaction((tx) => {
    tx.insert(vendors)
      .values({ id, businessId, ...profile, ...payout, detailsHash: payoutHashOf(payout), verifiedAt: null, status: "active", createdBy: by.id, createdAt: now() })
      .run();
    tx.insert(vendorChanges).values({ id: newId("vch"), businessId, vendorId: id, kind: "initial", proposedJson: JSON.stringify(payout), source: "operator", requestedBy: by.id, status: "pending", createdAt: now() }).run();
  });
  audit(db, { obligationId: null, actor: by.id, action: "vendor.created", detail: { vendorId: id, name: profile.name, payout: maskPayout(payout) } });
  return id;
}

/** Name, role, contact, notes and account code change directly. Payout details do not: see proposePayoutChange. */
export function updateVendorProfile(db: Db, businessId: string, by: Actor, vendorId: string, profileRaw: unknown): void {
  requirePermission(by, "edit_vendor", "edit vendors");
  const v = mustVendor(db, businessId, vendorId);
  const profile = validateProfile(profileRaw);
  const changed = Object.fromEntries(Object.entries(profile).filter(([k, val]) => (v as Record<string, unknown>)[k] !== val));
  if (!Object.keys(changed).length) return;
  db.update(vendors).set({ ...changed, ...("taxForm" in changed ? { taxFormAt: now() } : {}) }).where(eq(vendors.id, vendorId)).run();
  audit(db, { obligationId: null, actor: by.id, action: "vendor.updated", detail: { vendorId, changed, previous: Object.fromEntries(Object.keys(changed).map((k) => [k, (v as Record<string, unknown>)[k]])) } });
}

/** New payout details wait for verification. The details on file keep working until then. */
export function proposePayoutChange(db: Db, businessId: string, by: Actor | { id: string; source: "onboarding" }, vendorId: string, payoutRaw: unknown, note?: string): string {
  if ("role" in by) requirePermission(by, "edit_vendor", "change payout details");
  const current = mustVendor(db, businessId, vendorId);
  // An empty account number field keeps the number on file (it is never sent back to the form); unticking keep drops it.
  const r = (typeof payoutRaw === "object" && payoutRaw !== null ? payoutRaw : {}) as Record<string, unknown>;
  const carry = !r.bankAccountNumber && current.bankAccountEnc && r.keepBankAccount !== false;
  const { keepBankAccount: _k, ...rest } = r;
  void _k;
  const payout = carry ? validatePayout({ ...rest, bankAccountEnc: current.bankAccountEnc }, { fromStore: true }) : validatePayout(rest);
  const id = newId("vch");
  db.transaction((tx) => {
    // A newer request replaces an older one still waiting: only one set of proposed details is ever live.
    tx.update(vendorChanges).set({ status: "superseded", decidedAt: now() }).where(and(eq(vendorChanges.vendorId, vendorId), eq(vendorChanges.status, "pending"))).run();
    tx.insert(vendorChanges)
      .values({ id, businessId, vendorId, kind: "payout", proposedJson: JSON.stringify(payout), source: "role" in by ? "operator" : "onboarding", requestedBy: by.id, status: "pending", note: note ?? null, createdAt: now() })
      .run();
  });
  audit(db, { obligationId: null, actor: by.id, action: "vendor.payout_change_requested", detail: { vendorId, changeId: id, proposed: maskPayout(payout) } });
  return id;
}

/** People who could verify a change requested by `requestedBy`: approvers and owners who are active and are not the requester. */
function otherVerifiers(db: Db, businessId: string, requestedBy: string): string[] {
  return db
    .select()
    .from(users)
    .where(and(eq(users.businessId, businessId), eq(users.active, true)))
    .all()
    .filter((u) => isRole(u.role) && can(u.role, "verify_vendor") && `user:${u.id}` !== requestedBy)
    .map((u) => u.id);
}

/**
 * Accept a pending change after checking it outside the channel it arrived on. The checker cannot be the person
 * who asked for it while anyone else could check; in a one-person business it is allowed and recorded as such.
 */
export function verifyVendorChange(db: Db, businessId: string, by: Actor, changeId: string, method: string, note?: string): void {
  requirePermission(by, "verify_vendor", "verify payout details");
  if (!(VERIFY_METHODS as readonly string[]).includes(method)) throw new Error(`Say how you checked: ${VERIFY_METHODS.join(", ")}`);
  const ch = db.select().from(vendorChanges).where(and(eq(vendorChanges.id, changeId), eq(vendorChanges.businessId, businessId))).get();
  if (!ch) throw new Error("No such change");
  if (ch.status !== "pending") throw new Error(`This change is already ${ch.status}`);
  let self = false;
  if (ch.requestedBy === by.id) {
    const others = otherVerifiers(db, businessId, ch.requestedBy);
    if (others.length) throw new Error(`You asked for this change, so someone else verifies it (${others.join(", ")} can)`);
    self = true;
  }
  const proposed = JSON.parse(ch.proposedJson) as PayoutInput & { profile?: VendorProfileInput; payout?: PayoutInput };
  const payout = validatePayout(ch.kind === "create" ? proposed.payout : proposed, { fromStore: true });
  const profile = ch.kind === "create" ? validateProfile(proposed.profile) : null;
  const ts = now();
  let vendorId = ch.vendorId;
  db.transaction((tx) => {
    // Compare-and-swap on the change, so two people verifying at once cannot both apply it.
    const won = tx.update(vendorChanges).set({ status: "approved", decidedBy: by.id, decidedAt: ts, method, note: note ?? null }).where(and(eq(vendorChanges.id, changeId), eq(vendorChanges.status, "pending"))).run();
    if (won.changes !== 1) throw new Error("This change was decided by someone else just now");
    if (profile) {
      if (tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.businessId, businessId), eq(vendors.name, profile.name))).get()) throw new Error("A vendor with this name already exists; turn this down and send that vendor a link to update their details instead");
      vendorId = newId("ven");
      tx.insert(vendors)
        .values({ id: vendorId, businessId, ...profile, ...payout, detailsHash: payoutHashOf(payout), verifiedAt: ts, verifiedBy: by.id, verificationMethod: method, status: "active", createdBy: ch.requestedBy, createdAt: ts })
        .run();
      tx.update(vendorChanges).set({ vendorId }).where(eq(vendorChanges.id, changeId)).run();
    } else {
      tx.update(vendors).set({ ...payout, detailsHash: payoutHashOf(payout), verifiedAt: ts, verifiedBy: by.id, verificationMethod: method }).where(eq(vendors.id, vendorId!)).run();
    }
  });
  audit(db, { obligationId: null, actor: by.id, action: self ? "vendor.self_verified" : "vendor.verified", detail: { vendorId, changeId, kind: ch.kind, method, requestedBy: ch.requestedBy, note: note ?? null } });
}

export function rejectVendorChange(db: Db, businessId: string, by: Actor, changeId: string, note?: string): void {
  requirePermission(by, "verify_vendor", "turn down payout changes");
  const won = db
    .update(vendorChanges)
    .set({ status: "rejected", decidedBy: by.id, decidedAt: now(), note: note ?? null })
    .where(and(eq(vendorChanges.id, changeId), eq(vendorChanges.businessId, businessId), eq(vendorChanges.status, "pending")))
    .run();
  if (won.changes !== 1) throw new Error("This change is not waiting any more");
  audit(db, { obligationId: null, actor: by.id, action: "vendor.change_rejected", detail: { changeId, note: note ?? null } });
}

/** Stop or restart payments to one vendor. Policy blocks every payment to a blocked vendor. */
export function setVendorStatus(db: Db, businessId: string, by: Actor, vendorId: string, status: "active" | "blocked", reason: string): void {
  requirePermission(by, "verify_vendor", status === "blocked" ? "block vendors" : "unblock vendors");
  const v = mustVendor(db, businessId, vendorId);
  const why = str(reason, "Reason", 200, true)!;
  if (v.status === status) return;
  db.update(vendors).set({ status }).where(eq(vendors.id, vendorId)).run();
  audit(db, { obligationId: null, actor: by.id, action: status === "blocked" ? "vendor.blocked" : "vendor.unblocked", detail: { vendorId, reason: why } });
}

export function pendingChanges(db: Db, businessId: string) {
  return db.select().from(vendorChanges).where(and(eq(vendorChanges.businessId, businessId), eq(vendorChanges.status, "pending"))).orderBy(desc(vendorChanges.createdAt)).all();
}

export function changesFor(db: Db, vendorId: string) {
  return db.select().from(vendorChanges).where(eq(vendorChanges.vendorId, vendorId)).orderBy(desc(vendorChanges.createdAt)).all();
}

/* Onboarding links: a vendor fills in their own details; a person still verifies them before any payment. */

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** A single-use link, valid for a week. Only its hash is stored, so the database never holds a working link. */
export function createInvite(db: Db, businessId: string, by: Actor, opts: { vendorId?: string | null; label?: string | null }): { token: string; expiresAt: string } {
  requirePermission(by, "invite_vendor", "send onboarding links");
  if (opts.vendorId) mustVendor(db, businessId, opts.vendorId);
  const label = str(opts.label, "Label", 80);
  const token = randomBytes(24).toString("base64url"); // 32 characters
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  db.insert(vendorInvites).values({ id: newId("inv"), businessId, tokenHash: hashToken(token), vendorId: opts.vendorId ?? null, label, createdBy: by.id, expiresAt, createdAt: now() }).run();
  audit(db, { obligationId: null, actor: by.id, action: "vendor.invite_created", detail: { vendorId: opts.vendorId ?? null, label, expiresAt } });
  return { token, expiresAt };
}

export type InviteView = { ok: true; businessId: string; vendorName: string | null; label: string | null; expiresAt: string } | { ok: false; reason: string };

export function lookupInvite(db: Db, token: string): InviteView {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return { ok: false, reason: "This link is not valid." };
  const inv = db.select().from(vendorInvites).where(eq(vendorInvites.tokenHash, hashToken(token))).get();
  if (!inv) return { ok: false, reason: "This link is not valid." };
  if (inv.usedAt) return { ok: false, reason: "This link has already been used. Ask for a new one if you need to change your details again." };
  if (inv.expiresAt <= now()) return { ok: false, reason: "This link has expired. Ask for a new one." };
  const v = inv.vendorId ? db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, inv.vendorId)).get() : null;
  return { ok: true, businessId: inv.businessId, vendorName: v?.name ?? null, label: inv.label, expiresAt: inv.expiresAt };
}

/** The vendor's submission. The link is spent first (compare-and-swap), so a link cannot be used twice even at once. */
export function submitOnboarding(db: Db, token: string, input: { profile?: unknown; payout: unknown }): void {
  const view = lookupInvite(db, token);
  if (!view.ok) throw new Error(view.reason);
  const inv = db.select().from(vendorInvites).where(eq(vendorInvites.tokenHash, hashToken(token))).get()!;
  const payout = validatePayout(input.payout);
  // A vendor states who they are; which tax form is on file and any withholding rate are for the business to record.
  const profile = inv.vendorId ? null : { ...validateProfile(input.profile), taxForm: null, withholdingBps: null };
  const actor = `vendor:onboarding:${inv.id}`;
  db.transaction((tx) => {
    const spent = tx.update(vendorInvites).set({ usedAt: now() }).where(and(eq(vendorInvites.id, inv.id), isNull(vendorInvites.usedAt))).run();
    if (spent.changes !== 1) throw new Error("This link has already been used.");
    if (inv.vendorId) {
      tx.update(vendorChanges).set({ status: "superseded", decidedAt: now() }).where(and(eq(vendorChanges.vendorId, inv.vendorId), eq(vendorChanges.status, "pending"))).run();
      tx.insert(vendorChanges).values({ id: newId("vch"), businessId: inv.businessId, vendorId: inv.vendorId, kind: "payout", proposedJson: JSON.stringify(payout), source: "onboarding", requestedBy: actor, status: "pending", createdAt: now() }).run();
    } else {
      tx.insert(vendorChanges).values({ id: newId("vch"), businessId: inv.businessId, vendorId: null, kind: "create", proposedJson: JSON.stringify({ profile, payout }), source: "onboarding", requestedBy: actor, status: "pending", createdAt: now() }).run();
    }
  });
  audit(db, { obligationId: null, actor, action: "vendor.onboarding_submitted", detail: { vendorId: inv.vendorId, name: profile?.name ?? null, payout: maskPayout(payout) } });
}

function mustVendor(db: Db, businessId: string, vendorId: string) {
  const v = db.select().from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.businessId, businessId))).get();
  if (!v) throw new Error("No such vendor");
  return v;
}

/** What the audit log keeps of payout details: enough to recognise them, not enough to reuse them. */
export function maskPayout(p: PayoutInput): Record<string, string | null> {
  const email = p.paypalEmail ? p.paypalEmail.replace(/^(.).*(@.*)$/, "$1***$2") : null;
  const stellar = p.stellarAccount ? `${p.stellarAccount.slice(0, 4)}…${p.stellarAccount.slice(-4)}` : null;
  return { paypalEmail: email, stellarAccount: stellar, bankLabel: p.bankLabel ?? null, bankCode: p.bankCode ?? null, accountHolder: p.accountHolder ?? null, preferredRail: p.preferredRail ?? null };
}

/** A pending change laid out for the person checking it: each payout field, proposed against what is on file. */
export function describeChange(db: Db, ch: typeof vendorChanges.$inferSelect) {
  const proposedRaw = JSON.parse(ch.proposedJson) as PayoutInput & { profile?: VendorProfileInput; payout?: PayoutInput };
  const payout: PayoutInput = ch.kind === "create" ? (proposedRaw.payout ?? {}) : proposedRaw;
  const v = ch.vendorId ? db.select().from(vendors).where(eq(vendors.id, ch.vendorId)).get() : null;
  const lines: Array<[string, string, string | null]> = [];
  if (ch.kind === "create" && proposedRaw.profile) {
    const p = proposedRaw.profile;
    lines.push(["Name", p.name, null], ["Role", p.role, null], ["Country", p.country, null], ["Email", p.email ?? "", null]);
  }
  lines.push(
    ["PayPal", payout.paypalEmail ?? "", v?.paypalEmail ?? null],
    ["Stellar", payout.stellarAccount ?? "", v?.stellarAccount ?? null],
    ["Bank", payout.bankLabel ? `${payout.bankLabel}, ${payout.bankCurrency} in ${payout.bankCountry}` : "", v?.bankLabel ? `${v.bankLabel}, ${v.bankCurrency} in ${v.bankCountry}` : null],
    ["Account holder", payout.accountHolder ?? "", v?.accountHolder ?? null],
    ["Prefers", payout.preferredRail ?? "", v?.preferredRail ?? null],
  );
  return {
    id: ch.id,
    kind: ch.kind,
    source: ch.source,
    requestedBy: ch.requestedBy,
    createdAt: ch.createdAt,
    vendorId: ch.vendorId,
    vendorName: v?.name ?? proposedRaw.profile?.name ?? null,
    lines,
    note: ch.note,
  };
}

/** Why this person cannot verify a change, or null when they can. Mirrors verifyVendorChange. */
export function verifyBarrier(db: Db, businessId: string, actorId: string, ch: typeof vendorChanges.$inferSelect): string | null {
  if (ch.requestedBy !== actorId) return null;
  const others = otherVerifiers(db, businessId, ch.requestedBy);
  return others.length ? `You asked for this, so someone else verifies it (${others.join(", ")} can).` : null;
}
