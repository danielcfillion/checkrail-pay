import { errorResponse } from "@/lib/api/http";
import { openApiSpec } from "@/lib/api/openapi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The API's description, docs/openapi.yaml as JSON. It holds no secrets and no business data, so it needs no key. */
export function GET() {
  try {
    return Response.json(openApiSpec(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (e) {
    console.error("[checkrail] openapi spec could not be read", e);
    return errorResponse(500, "internal_error", "The API description could not be read");
  }
}
