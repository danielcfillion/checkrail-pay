import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { readDocument, proposeFromText } from "./documents";
import { openTestDb } from "../db";
import { seedDemo } from "../demo/seed";
import { uploadDocument } from "../engine/attachments";
import { ingestObligation } from "../engine/orchestrator";
import { evidence, obligations } from "../db/schema";

const pdf = () => readFileSync(path.join(__dirname, "__fixtures__", "invoice-kalaw.pdf"));

describe("document reader (mock mode, no model)", () => {
  it("reads a text-layer PDF invoice and proposes the total due, not the unit rate", async () => {
    const r = await readDocument({ name: "invoice-kalaw.pdf", mimeType: "application/pdf", bytes: pdf(), baseCurrency: "USD" });
    expect(r.reader).toBe("pdf-text");
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0].amountMinor).toBe(42_000);
    expect(r.proposed[0].reference).toBe("INV-KTC-0210");
    expect(r.proposed[0].kind).toBe("invoice");
  });

  it("refuses to invent figures for an image without a model", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const r = await readDocument({ name: "chat.png", mimeType: "image/png", bytes: png, baseCurrency: "USD" });
    expect(r.reader).toBe("none");
    expect(r.proposed).toEqual([]);
    expect(r.note).toMatch(/needs a model/);
  });

  it("prefers balance due over the gross figure in plain text", () => {
    const [p] = proposeFromText("Invoice INV-9 total USD 680.00, less deposit USD 200.00, balance due USD 480.00", "inv.txt", "USD");
    expect(p.amountMinor).toBe(48_000);
  });
});

describe("uploaded document to obligation", () => {
  it("evidence read from the document is provenance 'document' and does not force approval; an edited figure becomes 'operator'", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const up = await uploadDocument(db, { businessId: "biz_ridgeline", name: "invoice-kalaw.pdf", mimeType: "application/pdf", bytes: pdf(), actor: "user:daniel" });
    expect(up.proposed[0].amountMinor).toBe(42_000);
    const row = up.proposed[0];
    const id = await ingestObligation(db, {
      businessId: "biz_ridgeline",
      sourceType: "invoice",
      rawInput: "Kalaw Trekking Collective invoice for KAL-2D-1002 attached.",
      evidence: [{ ...row, attachmentId: up.attachmentId }],
      evidenceSource: "operator",
      actor: "user:daniel",
    });
    const ev = db.select().from(evidence).where(eq(evidence.obligationId, id)).get()!;
    expect(ev.provenance).toBe("document");
    expect(ev.attachmentId).toBe(up.attachmentId);
    const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(ob.amountMinor).toBe(42_000);
    expect(ob.policyReasonsJson ?? "[]").not.toMatch(/operator/);

    const edited = await ingestObligation(db, {
      businessId: "biz_ridgeline",
      sourceType: "invoice",
      rawInput: "Kalaw Trekking Collective invoice for KAL-2D-1003, USD 500.",
      evidence: [{ ...row, amountMinor: 50_000, reference: "INV-KTC-0211", attachmentId: up.attachmentId }],
      evidenceSource: "operator",
      actor: "user:daniel",
    });
    const ev2 = db.select().from(evidence).where(eq(evidence.obligationId, edited)).get()!;
    expect(ev2.provenance).toBe("operator");
  });
});
