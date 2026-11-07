import { getDb } from "@/lib/db";
import { handleXeroCallback } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** Xero sends the owner back here with a code and the state. See src/lib/accounting/xeroRoutes.ts. */
export function GET(req: Request) {
  return handleXeroCallback(req, getDb());
}
