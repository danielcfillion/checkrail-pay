import { businessOf, handleApi, intParam } from "@/lib/api/http";
import { hasScope } from "@/lib/api/keys";
import { LIST_LIMIT, REQUEST_BODY_LIMIT, createRequest, listOwnRequests } from "@/lib/api/requests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST puts a payment request in the inbox (requests:write; an Idempotency-Key header is required). Policy and the
 * autonomy setting decide; nothing here can approve or send. GET lists the requests this key made (requests:read),
 * optionally by reference.
 */

export function POST(req: Request) {
  return handleApi(req, { scope: "requests:write", bodyLimit: REQUEST_BODY_LIMIT, idempotency: "required" }, async ({ db, key, body }) => {
    const biz = businessOf(db);
    const idem = req.headers.get("idempotency-key")!.trim();
    const made = await createRequest(db, biz.id, key, idem, body);
    // A key that may not read requests learns only that its request was taken: no reasons, nothing about other parts.
    return { status: 201, body: hasScope(key, "requests:read") ? made : { id: made.id, status: made.status, idempotency_key: idem } };
  });
}

export function GET(req: Request) {
  return handleApi(req, { scope: "requests:read" }, ({ db, key, url }) => {
    businessOf(db);
    return { status: 200, body: { requests: listOwnRequests(db, key, url.searchParams.get("reference"), intParam(url, "limit", 20, LIST_LIMIT)) } };
  });
}
