import { getDb } from "@/lib/db";
import { billExportFile } from "@/lib/accounting/xeroBills";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * One recorded Xero bills export, byte for byte the file first downloaded (that first download comes from here too).
 * Read-only: it marks nothing. The bills in it must not be imported into Xero a second time.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer || !viewer.can("export")) return new Response("Not allowed", { status: 403 });
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  const { id } = await params;
  const file = biz ? billExportFile(db, biz.id, id) : null;
  if (!file) return new Response("No such export", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file.fileName}"`, "Cache-Control": "no-store", "X-Bill-Count": String(file.billCount) },
  });
}
