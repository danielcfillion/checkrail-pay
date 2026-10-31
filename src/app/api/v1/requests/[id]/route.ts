import { businessOf, handleApi } from "@/lib/api/http";
import { ownRequest } from "@/lib/api/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One request this key made: state, verdict, reasons, amounts, rail and settlement. Never payout details. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApi(req, { scope: "requests:read" }, ({ db, key }) => {
    businessOf(db);
    return { status: 200, body: ownRequest(db, key, id) };
  });
}
