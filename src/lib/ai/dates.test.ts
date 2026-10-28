import { describe, it, expect } from "vitest";
import { extractInvoiceDates } from "./extractor";

describe("invoice dates", () => {
  const today = "2026-10-26";
  it("reads the issue date and counts terms from it", () => {
    expect(extractInvoiceDates("INVOICE INV-DUC-001\nDate: 22 October 2026\nTerms: Net 14", today)).toEqual({ invoiceDate: "2026-10-22", dueDate: "2026-11-05", termsDays: 14 });
    expect(extractInvoiceDates("Invoice date 2026-10-01, due by 15/10/2026", today)).toMatchObject({ invoiceDate: "2026-10-01", dueDate: "2026-10-15" });
    expect(extractInvoiceDates("Hoa don ngay 20 thang 10 nam 2026, han thanh toan: 30/10/2026", today)).toMatchObject({ invoiceDate: "2026-10-20", dueDate: "2026-10-30" });
    expect(extractInvoiceDates("Dated October 3, 2026. Please pay within 7 days.", today)).toMatchObject({ invoiceDate: "2026-10-03", dueDate: "2026-10-10" });
  });
  it("leaves dates empty rather than guess, and never reads pressure as a due date", () => {
    expect(extractInvoiceDates("Pay Phuong USD 960 today, urgent", today)).toEqual({ invoiceDate: null, dueDate: null, termsDays: null });
    expect(extractInvoiceDates("Net 30", today).dueDate).toBe("2026-11-25");
    expect(extractInvoiceDates("Date: 31/02/2026", today).invoiceDate).toBeNull();
  });
});
