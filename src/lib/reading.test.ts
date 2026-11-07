import { describe, expect, it } from "vitest";
import { openTestDb } from "./db";
import { seedDemo } from "./demo/seed";
import { findObligationsBySourceRef, getObligationDetail } from "./queries";
import { readerNotesFor, readingFor } from "./reading";
import { ingestObligation, rejectObligation } from "./engine/orchestrator";
import { DEMO_BUSINESS_ID } from "./demo/seed";
import { checkStatement } from "@/components/check-statement";

describe("what the countdown and Daily close show about a scheduled request's reading", () => {
  it("is the same reading, and the same statement, as the request page", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const id = (ref: string) => findObligationsBySourceRef([ref], db).find((r) => r.state !== "cancelled")!.id;
    const maria = id("JOB-HG4D-0921");
    const d = getObligationDetail(maria, db)!;
    const { recorded, reader } = readingFor(d, db);
    // Maria's recorded Claude run: 25%, two concerns that the rules in the demo never see.
    expect(recorded?.confidence).toBe(25);
    expect(reader).toMatchObject({ recorded: true, confidence: 25 });
    expect(reader!.concerns.length).toBe(2);

    const notes = readerNotesFor([maria], db);
    expect(notes[maria]).toEqual({
      chip: "2 reader concerns",
      line: "The recorded Claude run raised 2 concerns: Possible duplicate. Confidence 25%. The rules did not see this run.",
    });
    // The countdown's chip is the request page's chip: same function, same data.
    expect(checkStatement({ rules: d.policyRules, reader }).chip).toBe(notes[maria].chip);
  });

  it("policy checks the confidence the page shows for a replayed reading (Phuong Transport, USD 960)", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const phuong = findObligationsBySourceRef(["INV-2026-0152"], db).find((r) => r.state !== "cancelled")!.id;
    const d = getObligationDetail(phuong, db)!;
    const { recorded, reader } = readingFor(d, db);
    expect(recorded?.confidence).toBe(15);
    expect(reader).toMatchObject({ recorded: true, confidence: 15 });
    const rule = d.policyRules.find((r) => r.ruleId === "ai_confidence")!;
    expect(rule.message).toBe("Agent confidence 15% is below the 75% threshold");
    expect(rule.message).toContain(`${reader!.confidence}%`);
    // Every seeded request whose page replays a reading, other than the two marked as reflecting the live account, agrees too.
    for (const ref of ["JOB-HG4D-0914", "HS-1027", "INV-DML-1010"]) {
      for (const row of findObligationsBySourceRef([ref], db)) {
        const od = getObligationDetail(row.id, db)!;
        const shown = readingFor(od, db);
        const conf = od.policyRules.find((r) => r.ruleId === "ai_confidence");
        if (shown.recorded && conf && /Agent confidence/.test(conf.message)) expect(conf.message).toContain(`Agent confidence ${shown.reader!.confidence}%`);
      }
    }
  });

  it("a resubmission with urgency text, after the original is cancelled, keeps the rules' lower figure, never the recorded 93", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const original = findObligationsBySourceRef(["INV-DML-1010"], db)[0].id;
    rejectObligation(db, original, "user:daniel", "cancelled for the test");
    const again = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "operator_instruction",
      rawInput: "URGENT pay today please! Dao Mountain Lodge invoice INV-DML-1010 for the Cao Bang departure CB-3D-1012: 10 rooms, 2 nights, total USD 850. 50% deposit USD 425 now to hold the rooms, they need it urgently.",
      evidence: [{ kind: "invoice", label: "Dao Mountain Lodge invoice INV-DML-1010", amountMinor: 85_000, currency: "USD", reference: "INV-DML-1010", excerpt: "Dao Mountain Lodge, Cao Bang. 10 rooms x 2 nights x USD 42.50 = USD 850.00. 50% deposit to confirm, balance on arrival." }],
      actor: "user:lan",
    });
    const d = getObligationDetail(again, db)!;
    expect(d.obligation.aiConfidence).not.toBe(93);
    const { recorded, reader } = readingFor(d, db);
    expect(recorded).toBeNull();
    const rule = d.policyRules.find((r) => r.ruleId === "ai_confidence")!;
    expect(rule.message).not.toContain("93%");
    if (/Agent confidence/.test(rule.message)) expect(rule.message).toContain(`Agent confidence ${reader!.confidence}%`);
  });

  it("leaves out a request whose reading is clear, and an id that does not exist", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const dao = findObligationsBySourceRef(["INV-DML-1010"], db)[0].id;
    const notes = readerNotesFor([dao, "obl_missing"], db);
    expect(notes).toEqual({});
  });
});
