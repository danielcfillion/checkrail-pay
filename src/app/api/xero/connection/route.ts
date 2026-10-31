import { getDb } from "@/lib/db";
import { handleXeroDisconnect } from "@/lib/accounting/xeroRoutes";

export const dynamic = "force-dynamic";

/** Disconnect Xero (owner only). See src/lib/accounting/xeroRoutes.ts. */
export function DELETE(req: Request) {
  return handleXeroDisconnect(req, getDb());
}
