import { getDb } from "@/lib/db";
import { handleXeroPush } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** "Push to Xero": send what is waiting now, failures included. Never touches a payment. */
export function POST(req: Request) {
  return handleXeroPush(req, getDb());
}
