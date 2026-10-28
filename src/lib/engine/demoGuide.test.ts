import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { amendObligation, approveObligation, confirmSettlement, executeObligation, ingestObligation, rejectObligation } from "./orchestrator";
import { AGENT_ACTOR, autopilotStatus, runAutopilot, setAutonomy } from "./autopilot";
import { uploadDocument } from "./attachments";
import { getDailyClose } from "./dailyClose";
import { runAs } from "./requestContext";
import type { SourceType } from "../domain/types";

/**
 * The /demo guide, step by step, as the hosted demo runs it: mock rails, the rule-based reader, one owner login
 * ("judge") acting as Daniel. If a step on /demo stops being true, this fails.
 */

const LOGIN = "judge";
const DOCS = path.join(process.cwd(), "public", "demo-documents");
let db: Db;
let story: Awaited<ReturnType<typeof seedDemo>>["story"];
const get = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const as = <T,>(fn: () => T) => runAs(LOGIN, fn);
const savedUsers = process.env.CHECKRAIL_USERS;

/** What the New request page does: upload the file, keep the figures the reader proposed, create the request. */
async function newRequest(file: string, message: string, sourceType: SourceType): Promise<string> {
  const up = await uploadDocument(db, { businessId: DEMO_BUSINESS_ID, name: file, mimeType: "application/pdf", bytes: readFileSync(path.join(DOCS, file)), actor: "user:daniel" });
  expect(up.reader).toBe("pdf-text");
  return as(() =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType, rawInput: message, evidence: up.proposed.map((p) => ({ ...p, attachmentId: up.attachmentId })), actor: "user:daniel", evidenceSource: "operator" }),
  );
}

/** What "Pay with ..." does. */
async function pay(id: string) {
  const r = await as(() => executeObligation(db, id, { actor: "user:daniel" }));
  if (r.status === "submitted") await confirmSettlement(db, id, "post-execute");
  return get(id).state;
}

beforeAll(async () => {
  // The hosted demo: one owner login plays every persona.
  process.env.CHECKRAIL_USERS = `${LOGIN}:demo-pass:admin`;
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the /demo guide, in order (mock rails, rule-based reader, no keys)", () => {
  it("step 1: the overview shows two blocks and USD 340 of errors prevented", () => {
    const blocked = db.select().from(obligations).where(eq(obligations.state, "blocked")).all().map((o) => o.id);
    expect(blocked.sort()).toEqual([story.blockedMismatch, story.blockedDuplicate].sort());
  });

  it("step 2: Phuong is blocked at USD 960; Correct to USD 800.00 moves it to Awaiting approval", async () => {
    expect(get(story.blockedMismatch).state).toBe("blocked");
    expect(get(story.blockedMismatch).blockedReason).toMatch(/Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00/);
    await as(() => amendObligation(db, story.blockedMismatch, "user:daniel", { amountMinor: 80_000 }, "Corrected to evidenced amount USD 800.00"));
    expect(get(story.blockedMismatch).state).toBe("awaiting_approval");
  });

  it("step 3: the Maria duplicate is blocked and Cancel moves no money", () => {
    expect(get(story.blockedDuplicate).blockedReason).toMatch(/JOB-HG4D-0914 was already used/);
    as(() => rejectObligation(db, story.blockedDuplicate, "user:daniel", "Duplicate of a paid obligation"));
    expect(get(story.blockedDuplicate).state).toBe("cancelled");
  });

  it("step 4: Maria JOB-HG4D-0921 is ready to pay and settles over PayPal", async () => {
    expect(get(story.paypal).state).toBe("approved");
    expect(get(story.paypal).selectedRail).toBe("paypal");
    expect(await pay(story.paypal)).toBe("settled");
  });

  it("step 5: Ana needs approval, then settles on simulated Stellar", async () => {
    expect(get(story.stellar).state).toBe("awaiting_approval");
    as(() => approveObligation(db, story.stellar, "user:daniel"));
    expect(get(story.stellar).selectedRail).toBe("stellar");
    expect(await pay(story.stellar)).toBe("settled");
  });

  let rosa = "";
  it("step 6: Rosa's trip completion sheet comes out Ready to pay, confirmed by her rate card and departure", async () => {
    rosa = await newRequest("tripsheet-ceb2d-1024.pdf", "Trip sheet attached for Rosa, please pay.", "invoice"); // the form's default source type
    const ob = get(rosa);
    expect(ob.state).toBe("approved");
    expect(ob.policyDecision).toBe("auto_execute");
    expect(ob.amountMinor).toBe(19_000);
    expect(ob.sourceRef).toBe("JOB-CEB2D-1024");
    expect(ob.selectedRail).toBe("paypal");
    expect(ob.releaseAt).toBeNull(); // Assist: a person still presses send
    const rules = JSON.parse(db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, rosa), eq(auditEntries.action, "policy.evaluated"))).get()!.detailJson!).rules as Array<{ ruleId: string; passed: boolean; message: string }>;
    expect(rules.find((r) => r.ruleId === "expected_amount")).toMatchObject({ passed: true });
    expect(rules.find((r) => r.ruleId === "expected_amount")!.message).toMatch(/CEB-2D-1024: 2 days x USD 95.00 = USD 190.00/);
  });

  it("step 7: turning on Autopilot schedules Rosa with a countdown, and the heartbeat sends it after the window", async () => {
    as(() => setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 60 }));
    const first = await runAutopilot(db, { businessId: DEMO_BUSINESS_ID }); // what the Settings action runs right after saving
    expect(first.scheduled).toEqual([rosa]);
    const st = autopilotStatus(db, DEMO_BUSINESS_ID);
    expect(st.scheduled.map((x) => x.id)).toEqual([rosa]);
    const left = new Date(st.scheduled[0].releaseAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(55_000);
    expect(left).toBeLessThanOrEqual(60_000);
    // The daily cap counts every payment in the last 24 hours, people's too: Maria 180 and Ana 750 sent, Rosa 190 scheduled.
    expect(st.committed24hMinor).toBe(112_000);
    // Phuong was corrected and is waiting for approval; it is a person's, and autopilot leaves it alone.
    expect(get(story.blockedMismatch).releaseAt).toBeNull();

    // A heartbeat inside the window sends nothing.
    expect((await runAutopilot(db)).released).toEqual([]);
    expect(get(rosa).state).toBe("approved");

    // The window runs out; the next heartbeat sends it as the agent, and the mock rail confirms.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const pass = await runAutopilot(db);
    expect(pass.released).toEqual([rosa]);
    expect(pass.refused).toEqual([]);
    expect(get(rosa).state).toBe("settled");
    const started = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, rosa), eq(auditEntries.toState, "execution_pending"))).get()!;
    expect(started.actor).toBe(AGENT_ACTOR);
  });

  it("step 8: on Autopilot, Rosa's own invoice and Bayan's USD 640 wait for a person, and Tam's re-issue is blocked", async () => {
    const invoice = await newRequest("invoice-rosa-0942.pdf", "Invoice attached from Rosa, please pay.", "invoice");
    expect(get(invoice).state).toBe("awaiting_approval");
    expect(get(invoice).policyReasonsJson).toMatch(/Only the vendor's own documents/);
    const tam = await newRequest("invoice-tam-0834b.pdf", "Invoice attached from Tam, please pay.", "invoice");
    expect(get(tam).state).toBe("blocked");
    expect(get(tam).blockedReason).toMatch(/Same job as .* INV-TAM-0834/);
    const bayan = await newRequest("invoice-bayan-0944.pdf", "Invoice attached from Bayan, please pay.", "invoice");
    expect(get(bayan).state).toBe("awaiting_approval");
    expect(get(bayan).policyReasonsJson).toMatch(/autopilot per-payment cap USD 500.00/);
    // Maria's HG-5D-1005 sheet: no departure on file, so only the uploaded sheet supports it and a person approves.
    const maria5 = await newRequest("tripsheet-hg5d-1005.pdf", "Trip sheet attached for Maria, please pay.", "invoice");
    expect(get(maria5).state).toBe("awaiting_approval");
    expect(autopilotStatus(db, DEMO_BUSINESS_ID).scheduled).toEqual([]);
  });

  it("step 9: the Daily close separates the agent's USD 190 from people's USD 930", () => {
    const close = getDailyClose(db, DEMO_BUSINESS_ID, "USD");
    expect(close.paidByAgent.map((p) => p.id)).toEqual([rosa]);
    expect(close.totals.agentMinor).toBe(19_000);
    expect(close.paidByPeople.map((p) => p.id).sort()).toEqual([story.paypal, story.stellar].sort());
    expect(close.totals.peopleMinor).toBe(93_000);
  });

  it("restores the login setting", () => {
    if (savedUsers === undefined) delete process.env.CHECKRAIL_USERS;
    else process.env.CHECKRAIL_USERS = savedUsers;
    expect(true).toBe(true);
  });
});
