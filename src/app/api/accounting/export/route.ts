import { getDb } from "@/lib/db";
import { allRecordsCsv } from "@/lib/accounting/record";

/**
 * Download every accounting record as CSV (Xero/QuickBooks bill import shape). Read-only: a GET never marks
 * records exported, so a second click or a prefetch cannot empty the file. Marking happens in exportCsvAction.
 */
export async function GET() {
  const { csv } = allRecordsCsv(getDb());
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="checkrail-pay-accounting-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
