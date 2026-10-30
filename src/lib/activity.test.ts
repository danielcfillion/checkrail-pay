import { describe, expect, it } from "vitest";
import { openTestDb } from "./db";
import { seedDemo } from "./demo/seed";
import { listAudit } from "./queries";
import { activityFeed, plainReason, shortReason } from "./activity";
import { entryParts, humaniseEntry } from "./format";

describe("live activity", () => {
  it("shows one row per event a person cares about, with vendor, reference and reason", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const feed = activityFeed(listAudit(400, db), 12);
    const line = (vendor: string, ref: string) => feed.find((r) => r.vendorName === vendor && r.sourceRef === ref)?.text;
    expect(line("Dao Mountain Lodge", "INV-DML-1010")).toBe("held for approval: above USD 250");
    expect(line("Phuong Transport", "INV-2026-0152")).toBe("blocked: asks USD 960, Trip sheet HG-4D-0927 says USD 800");
    expect(line("Maria Santos", "JOB-HG4D-0914")).toBe("blocked: JOB-HG4D-0914 was already paid");
    expect(line("Maria Santos", "JOB-HG4D-0921")).toBe("passed the rules, nobody needed to approve");
    // No system noise: reading, rule checks and rail choice stay in the audit log.
    expect(feed.every((r) => !/rail selected|rules evaluated|read the request/i.test(r.text))).toBe(true);
    // One row per event: each audit entry appears at most once.
    expect(new Set(feed.map((r) => r.id)).size).toBe(feed.length);
  });

  it("shows an approval once, not also as cleared to pay", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const { approveObligation } = await import("./engine/orchestrator");
    approveObligation(db, story.stellar, "user:daniel");
    const rows = activityFeed(listAudit(400, db), 50).filter((r) => r.obligationId === story.stellar);
    expect(rows.map((r) => r.kind)).toEqual(["approved", "held"]);
  });

  it("shortens the engine's reasons", () => {
    expect(shortReason("Amount exceeds the autopilot per-payment cap USD 500.00")).toBe("above the USD 500 autopilot cap");
    expect(shortReason("Only the vendor's own documents support this amount; it is paid without a person only when ...")).toBe("only the vendor's own documents support it");
  });
});

describe("audit humaniser", () => {
  it("never says the actor twice", () => {
    expect(humaniseEntry("policy", "policy.evaluated")).toBe("Policy checked the rules");
    expect(humaniseEntry("ai:rules", "ai.interpreted")).toBe("The rule-based reader read the request");
    expect(humaniseEntry("system:email-ingest", "obligation.created")).toBe("Created from the invoice inbox");
    expect(humaniseEntry("router", "router.something_new")).toBe("Router something new");
    expect(entryParts("policy", "policy.require_approval")).toEqual({ who: "Policy", what: "held it for approval" });
  });
});

describe("round 2 wording and order", () => {
  it("reads the agent's send before its result (DS2-28)", () => {
    const feed = activityFeed;
    const at = "2026-10-29T10:00:00.000Z";
    const later = "2026-10-29T10:00:02.000Z";
    const base = { obligationId: "o1", vendorName: "Rosa Villanueva", sourceRef: "JOB-CEB2D-1024", detail: null };
    const rows = feed([
      { ...base, id: "c", seq: 3, actor: "rail:paypal", action: "settlement.confirmed", createdAt: later },
      { ...base, id: "b", seq: 2, actor: "agent:autopilot", action: "autopilot.releasing", createdAt: at },
      { ...base, id: "a", seq: 1, actor: "agent:autopilot", action: "autopilot.scheduled", createdAt: "2026-10-29T09:59:00.000Z" },
    ]);
    expect(rows.map((r) => r.text)).toEqual(["sent by autopilot", "paid over PayPal", "scheduled by autopilot, can be cancelled until it sends"]);
  });

  it("says policy reasons in plain words (DS2-16)", () => {
    expect(plainReason("Amount exceeds auto-execute threshold USD 250.00")).toBe("Above USD 250: a person approves");
    // A state code in the engine's duplicate message is shown as the state's label (NEW-4).
    expect(plainReason("Reference JOB-KAL2D-1002 was already used by obligation obl_abc123 (awaiting_approval)")).toBe("Reference JOB-KAL2D-1002 was already used by an earlier request (awaiting approval)");
    expect(plainReason("Amount exceeds the autopilot per-payment cap USD 500.00")).toBe("Above the USD 500 autopilot cap: a person approves");
    expect(plainReason("Same job as obligation obl_4fbc2b0094b54704 (settled): both name INV-TAM-0834")).toBe("Same job as an earlier request (settled): both name INV-TAM-0834");
    expect(plainReason("New since approval: Amount exceeds auto-execute threshold USD 250.00")).toBe("New since approval: above USD 250: a person approves");
  });
});
