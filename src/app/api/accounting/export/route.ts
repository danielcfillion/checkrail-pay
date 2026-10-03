import { getDb } from "@/lib/db";
import { exportPendingCsv } from "@/lib/accounting/record";

/** Download pending accounting records as CSV (Xero/QuickBooks bill import shape). */
export async function GET() {
  const { csv } = exportPendingCsv(getDb());
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="dueline-accounting-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
