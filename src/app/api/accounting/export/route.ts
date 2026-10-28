import { getDb } from "@/lib/db";
import { allRecordsCsv } from "@/lib/accounting/record";
import { getViewer } from "@/lib/viewer";

/**
 * Download every accounting record as CSV (Xero/QuickBooks bill import shape). Read-only: a GET never marks
 * records exported, so a second click or a prefetch cannot empty the file. Marking happens in exportCsvAction.
 */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer || !viewer.can("export")) return new Response("Not allowed", { status: 403 });
  const { csv } = allRecordsCsv(getDb());
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="checkrail-pay-accounting-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" },
  });
}
