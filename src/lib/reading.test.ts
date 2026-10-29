import { describe, expect, it } from "vitest";
import { openTestDb } from "./db";
import { seedDemo } from "./demo/seed";
import { findObligationsBySourceRef, getObligationDetail } from "./queries";
import { readerNotesFor, readingFor } from "./reading";
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

  it("leaves out a request whose reading is clear, and an id that does not exist", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const dao = findObligationsBySourceRef(["INV-DML-1010"], db)[0].id;
    const notes = readerNotesFor([dao, "obl_missing"], db);
    expect(notes).toEqual({});
  });
});
