import { getDb } from "@/lib/db";
import { handleXeroMapping } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** Save the Xero account mapping (owner only). */
export function POST(req: Request) {
  return handleXeroMapping(req, getDb());
}
