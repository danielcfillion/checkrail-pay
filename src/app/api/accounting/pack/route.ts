import { getDb } from "@/lib/db";
import { buildBookkeeperPack } from "@/lib/accounting/bookkeeperPack";
import { localDateString } from "@/lib/format";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/** The bookkeeper pack (.xlsx): for the accountant to read and check, not to import. Read-only: it marks nothing. */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer || !viewer.can("export")) return new Response("Not allowed", { status: 403 });
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  if (!biz) return new Response("No business configured", { status: 404 });
  const { buffer } = await buildBookkeeperPack(db, biz.id);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="checkrail-pay-bookkeeper-pack-${localDateString()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
