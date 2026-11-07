import { getDb } from "@/lib/db";
import { buildBookkeeperPack, defaultPackPeriod, type PackPeriod } from "@/lib/accounting/bookkeeperPack";
import { localDateString } from "@/lib/format";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The bookkeeper pack (.xlsx): for the accountant to read and check, not to import. Read-only: it marks nothing.
 * ?period=all for everything on record, ?from=YYYY-MM-DD&to=YYYY-MM-DD for a period; by default this month and last.
 */
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer || !viewer.can("export")) return new Response("Not allowed", { status: 403 });
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  if (!biz) return new Response("No business configured", { status: 404 });
  const q = new URL(req.url).searchParams;
  const from = q.get("from");
  const to = q.get("to");
  let period: PackPeriod = defaultPackPeriod();
  if (q.get("period") === "all") period = "all";
  else if (from || to) {
    if (!from || !to || !DATE.test(from) || !DATE.test(to) || from > to) return new Response("Give from and to as YYYY-MM-DD, from not after to", { status: 400 });
    period = { from, to };
  }
  const { buffer } = await buildBookkeeperPack(db, biz.id, { period });
  const span = period === "all" ? "all" : `${period.from}-to-${period.to}`;
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="checkrail-pay-bookkeeper-pack-${span}-${localDateString()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
