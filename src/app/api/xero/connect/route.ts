import { getDb } from "@/lib/db";
import { handleXeroConnect } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** Start "Connect to Xero" (owner only). See src/lib/accounting/xeroRoutes.ts. */
export function GET(req: Request) {
  return handleXeroConnect(req, getDb());
}
