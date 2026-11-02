import { businessOf, handleApi } from "@/lib/api/http";
import { departuresSince, upsertDepartures, validateDepartures } from "@/lib/api/departures";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The booking feed. POST upserts departures by the booking system's own id; GET reads them back. Both need the
 * departures:write scope. See docs/API.md and docs/openapi.yaml.
 */

export function POST(req: Request) {
  return handleApi(req, { scope: "departures:write", bodyLimit: 512 * 1024, idempotency: "optional" }, async ({ db, key, body }) => {
    const biz = businessOf(db);
    const items = validateDepartures(db, biz.id, body);
    return { status: 200, body: await upsertDepartures(db, biz.id, key.name, items) };
  });
}

export function GET(req: Request) {
  return handleApi(req, { scope: "departures:write" }, ({ db, key, url }) => {
    const biz = businessOf(db);
    return { status: 200, body: { departures: departuresSince(db, biz.id, key.name, url.searchParams.get("since")) } };
  });
}
