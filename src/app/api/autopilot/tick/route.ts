import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runAutopilot } from "@/lib/engine/autopilot";
import { safeEqual } from "@/lib/basicAuth";

export const dynamic = "force-dynamic";

/**
 * One autopilot pass, for an external scheduler (cron, a platform job) when the in-process heartbeat is off.
 * It takes no input: a caller can only ask the agent to do what policy already allows, never direct a payment.
 * A scheduler authenticates with CHECKRAIL_TICK_TOKEN as a bearer token (the middleware lets this one path through
 * without a login only when a token is set, and the token is checked here). With live rails a token is required.
 * On simulated rails, without a token, a signed-in caller may send the custom header x-checkrail-tick, which a
 * cross-site form cannot send.
 */
export async function POST(req: Request) {
  const token = process.env.CHECKRAIL_TICK_TOKEN?.trim();
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) {
    if (!(bearer && safeEqual(bearer, token))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  } else if (process.env.RAIL_MODE === "live") {
    return NextResponse.json({ error: "Set CHECKRAIL_TICK_TOKEN to call the autopilot from outside with live rails" }, { status: 403 });
  } else if (req.headers.get("x-checkrail-tick") !== "1") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json(await runAutopilot(getDb()));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
