import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, obligations, users, vendorChanges, vendorInvites, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation, payoutHashOf, runPolicy } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createInvite, createVendor, lookupInvite, pendingChanges, proposePayoutChange, setVendorStatus, submitOnboarding, verifyVendorChange } from "./vendors";

let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const vendor = (id: string) => db.select().from(vendors).where(eq(vendors.id, id)).get()!;
const actions = () => db.select({ a: auditEntries.action }).from(auditEntries).all().map((r) => r.a);

const PROFILE = { name: "Hoang Van Duc", role: "driver", country: "VN", email: "duc@example.com" };
const PAYOUT = { paypalEmail: "duc.payouts@example.com", preferredRail: "paypal" };

beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("vendor master: maker-checker on payout details", () => {
  it("a new vendor cannot be paid until someone other than the person who added them verifies the details", async () => {
    const id = createVendor(db, DEMO_BUSINESS_ID, as("lan"), PROFILE, PAYOUT);
    expect(vendor(id).verifiedAt).toBeNull();
    const ob = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-HVD-0001 Hoang Van Duc: transfer Ha Giang to Hanoi, total USD 120.",
      evidence: [{ kind: "invoice", label: "Invoice INV-HVD-0001", amountMinor: 12_000, currency: "USD", reference: "INV-HVD-0001", excerpt: "Hoang Van Duc USD 120.00" }],
      actor: "user:lan",
    });
    expect(db.select().from(obligations).where(eq(obligations.id, ob)).get()!.state).toBe("blocked");
    const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
    expect(() => verifyVendorChange(db, DEMO_BUSINESS_ID, as("lan"), ch.id, "callback")).toThrow(/cannot verify/);
    expect(() => verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), ch.id, "email")).toThrow(/Say how you checked/);
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), ch.id, "callback", "Called Duc on the number from his 2025 contract");
    expect(vendor(id).verifiedAt).not.toBeNull();
    expect(vendor(id).verifiedBy).toBe("user:minh");
    expect(runPolicy(db, ob).rules.find((r) => r.ruleId === "recipient_verified")?.passed).toBe(true);
    expect(() => verifyVendorChange(db, DEMO_BUSINESS_ID, as("daniel"), ch.id, "callback")).toThrow(/already approved/);
  });

  it("new payout details leave the old ones in use until verified, and the requester cannot verify their own", () => {
    const before = vendor("ven_maria");
    expect(() => proposePayoutChange(db, DEMO_BUSINESS_ID, as("minh"), "ven_maria", { paypalEmail: "x@example.com" })).toThrow(/cannot change payout details/);
    const chId = proposePayoutChange(db, DEMO_BUSINESS_ID, as("daniel"), "ven_maria", { paypalEmail: "maria.new@example.com" }, "Vendor emailed new details");
    expect(vendor("ven_maria").paypalEmail).toBe(before.paypalEmail);
    expect(() => verifyVendorChange(db, DEMO_BUSINESS_ID, as("daniel"), chId, "callback")).toThrow(/You asked for this change/);
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), chId, "callback");
    const after = vendor("ven_maria");
    expect(after.paypalEmail).toBe("maria.new@example.com");
    expect(after.detailsHash).toBe(payoutHashOf(after));
    expect(after.detailsHash).not.toBe(before.detailsHash);
  });

  it("refuses details that are malformed or would store a full bank account number", () => {
    const lan = as("lan");
    expect(() => createVendor(db, DEMO_BUSINESS_ID, lan, PROFILE, { bankLabel: "Vietcombank 0071000123456", bankCountry: "VN", bankCurrency: "VND" })).toThrow(/masked/);
    expect(() => createVendor(db, DEMO_BUSINESS_ID, lan, PROFILE, { stellarAccount: "GABC" })).toThrow(/public key/);
    expect(() => createVendor(db, DEMO_BUSINESS_ID, lan, PROFILE, {})).toThrow(/at least one way/);
    expect(() => createVendor(db, DEMO_BUSINESS_ID, lan, { ...PROFILE, role: "hacker" }, PAYOUT)).toThrow(/Role must be/);
    expect(() => createVendor(db, DEMO_BUSINESS_ID, as("thu"), PROFILE, PAYOUT)).toThrow(/cannot add vendors/);
  });

  it("a one-person business verifies its own entries, and the audit says so", () => {
    db.update(users).set({ active: false }).where(eq(users.id, "minh")).run();
    const id = createVendor(db, DEMO_BUSINESS_ID, as("daniel"), PROFILE, PAYOUT);
    const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("daniel"), ch.id, "in_person");
    expect(vendor(id).verifiedAt).not.toBeNull();
    expect(actions()).toContain("vendor.self_verified");
  });

  it("a blocked vendor is never paid", () => {
    expect(() => setVendorStatus(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", "blocked", "test")).toThrow(/cannot block/);
    setVendorStatus(db, DEMO_BUSINESS_ID, as("minh"), "ven_maria", "blocked", "Disputed invoice");
    const ob = db.select().from(obligations).where(eq(obligations.vendorId, "ven_maria")).get()!;
    const outcome = runPolicy(db, ob.id);
    expect(outcome.decision).toBe("block");
    expect(outcome.rules.find((r) => r.ruleId === "vendor_active")?.passed).toBe(false);
  });
});

describe("vendor onboarding links", () => {
  it("are single use, store only a hash, and still need a person to verify", () => {
    const { token } = createInvite(db, DEMO_BUSINESS_ID, as("lan"), { label: "New driver" });
    expect(db.select().from(vendorInvites).all().some((i) => i.tokenHash === token)).toBe(false);
    expect(lookupInvite(db, token).ok).toBe(true);
    submitOnboarding(db, token, { profile: PROFILE, payout: PAYOUT });
    expect(lookupInvite(db, token).ok).toBe(false);
    expect(() => submitOnboarding(db, token, { profile: PROFILE, payout: PAYOUT })).toThrow(/already been used/);
    expect(db.select().from(vendors).where(eq(vendors.name, PROFILE.name)).get()).toBeUndefined();
    const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
    expect(ch.kind).toBe("create");
    // The person who sent the link may verify what came back: the vendor, not they, entered it.
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), ch.id, "callback");
    const v = db.select().from(vendors).where(eq(vendors.name, PROFILE.name)).get()!;
    expect(v.verifiedAt).not.toBeNull();
    expect(db.select().from(vendorChanges).where(eq(vendorChanges.id, ch.id)).get()!.vendorId).toBe(v.id);
  });

  it("refuse expired and malformed tokens", () => {
    const { token } = createInvite(db, DEMO_BUSINESS_ID, as("lan"), { vendorId: "ven_maria" });
    db.update(vendorInvites).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
    expect(lookupInvite(db, token)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(lookupInvite(db, "../../etc").ok).toBe(false);
    expect(() => submitOnboarding(db, token, { payout: PAYOUT })).toThrow(/expired/);
  });

  it("for an existing vendor file a payout change, never an edit", () => {
    const before = vendor("ven_maria").paypalEmail;
    const { token } = createInvite(db, DEMO_BUSINESS_ID, as("lan"), { vendorId: "ven_maria" });
    submitOnboarding(db, token, { payout: { paypalEmail: "maria.self@example.com" } });
    expect(vendor("ven_maria").paypalEmail).toBe(before);
    expect(pendingChanges(db, DEMO_BUSINESS_ID)[0]).toMatchObject({ kind: "payout", vendorId: "ven_maria", source: "onboarding" });
  });
});
