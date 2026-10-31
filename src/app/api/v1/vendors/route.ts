import { businessOf, handleApi, intParam } from "@/lib/api/http";
import { searchVendors } from "@/lib/api/vendors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Supplier lookup (vendors:read): id, name, verified or not. Never payout details. */
export function GET(req: Request) {
  return handleApi(req, { scope: "vendors:read" }, ({ db, url }) => {
    const biz = businessOf(db);
    return { status: 200, body: { vendors: searchVendors(db, biz.id, url.searchParams.get("q"), intParam(url, "limit", 25, 100)) } };
  });
}
