import { getDb } from "@/lib/db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { isRole } from "@/lib/auth/roles";
import { resolveActor } from "@/lib/engine/users";
import { getBusiness } from "@/lib/queries";
import { onboardingDashboard, type DashboardData } from "@/lib/onboarding/dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The onboarding dashboard's data as JSON, for AG Studio data sources that load by URL.
 *
 *   GET /api/onboarding/dashboard                 every data source: { readiness_summary: [...], readiness: [...], ... }
 *   GET /api/onboarding/dashboard?source=calls    one data source as a bare array
 *
 * Field names are documented at the top of src/lib/onboarding/dashboard.ts. Reads only. The middleware requires a
 * login on this path; any signed-in role may read it.
 */

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request): Promise<Response> {
  if (req.headers.get("x-checkrail-public") === "1") return json(401, { error: "Not signed in" });
  const username = req.headers.get(ACTOR_HEADER);
  const role = req.headers.get(ROLE_HEADER);
  if (!username || !isRole(role)) return json(401, { error: "Not signed in" });
  const db = getDb();
  const biz = getBusiness(db);
  if (!biz) return json(404, { error: "No business configured" });
  try {
    resolveActor(db, biz.id, username, role, req.headers.get(PERSONA_HEADER) ?? undefined);
  } catch (e) {
    return json(403, { error: (e as Error).message });
  }
  const data = onboardingDashboard(db, biz.id);
  const source = new URL(req.url).searchParams.get("source");
  if (source === null) return json(200, data);
  if (!Object.prototype.hasOwnProperty.call(data, source)) return json(400, { error: `Unknown source. One of: ${Object.keys(data).join(", ")}` });
  return json(200, data[source as keyof DashboardData]);
}
