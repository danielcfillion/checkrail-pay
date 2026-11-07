import { getDb } from "@/lib/db";
import { handleXeroAccounts } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** Read the connected organisation's chart of accounts again (owner only). */
export function POST(req: Request) {
  return handleXeroAccounts(req, getDb());
}
