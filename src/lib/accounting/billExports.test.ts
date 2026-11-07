import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { openTestDb } from "../db";
import { billExports } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation } from "../engine/orchestrator";
import { billExportFile, exportNewXeroBills, listBillExports, xeroBillRows, XERO_BILL_COLUMNS } from "./xeroBills";

describe("Xero bills export history", () => {
  it("records every export (when, who, how many, the exact file) and serves it again byte for byte, changing nothing", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db);
    expect(listBillExports(db, DEMO_BUSINESS_ID)).toEqual([]);

    const first = exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:thu");
    expect(first.count).toBeGreaterThan(1);
    expect(first.exportId).toBeTruthy();
    // The import file is still Xero's plain CSV template.
    expect(first.csv.split("\r\n")[0]).toBe(XERO_BILL_COLUMNS.join(","));

    const [rec] = listBillExports(db, DEMO_BUSINESS_ID);
    expect(rec).toMatchObject({ id: first.exportId, actor: "user:thu", billCount: first.count });
    expect(rec.fileName).toMatch(/^xero-bills-\d{4}-\d{2}-\d{2}-[\w-]{6}\.csv$/);

    // The download: BOM + the same CSV text the export produced, and identical every time.
    const a = billExportFile(db, DEMO_BUSINESS_ID, first.exportId!)!;
    const b = billExportFile(db, DEMO_BUSINESS_ID, first.exportId!)!;
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(a.bytes.subarray(3).toString("utf8")).toBe(first.csv);
    expect(a.billCount).toBe(first.count);
    const stored = db.select().from(billExports).all()[0];
    expect(createHash("sha256").update(a.bytes).digest("hex")).toBe(stored.sha256);

    // Downloading again marked nothing: still nothing new, and an empty export is not recorded.
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows).toHaveLength(0);
    const empty = exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:thu");
    expect(empty).toMatchObject({ count: 0, exportId: null });
    expect(listBillExports(db, DEMO_BUSINESS_ID)).toHaveLength(1);

    // A newly approved bill makes a second export holding only it; the first file is unchanged.
    approveObligation(db, story.stellar, "user:daniel");
    const second = exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:minh");
    expect(second.count).toBe(1);
    expect(second.csv).toMatch(/JOB-PAL3D-0927/);
    const list = listBillExports(db, DEMO_BUSINESS_ID);
    expect(list.map((e) => e.id)).toEqual([second.exportId, first.exportId]);
    expect(billExportFile(db, DEMO_BUSINESS_ID, first.exportId!)!.bytes.equals(a.bytes)).toBe(true);
  });

  it("refuses another business's export, an unknown id, and a stored file that no longer matches its checksum", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const { exportId } = exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:thu");
    expect(billExportFile(db, "biz_other", exportId!)).toBeNull();
    expect(billExportFile(db, DEMO_BUSINESS_ID, "bex_nope")).toBeNull();
    db.update(billExports).set({ content: "tampered" }).run();
    expect(() => billExportFile(db, DEMO_BUSINESS_ID, exportId!)).toThrow(/checksum/);
  });
});
