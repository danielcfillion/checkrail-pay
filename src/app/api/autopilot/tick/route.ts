import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runAutopilot } from "@/lib/engine/autopilot";
import { safeEqual } from "@/lib/basicAuth";

export const dynamic = "force-dynamic";

/**
 * One autopilot pass, for an external scheduler (cron, a platform job) when the in-process heartbeat is off.
 * It takes no input: a caller can only ask the agent to do what policy already allows, never direct a payment.
 * A scheduler authenticates with CHECKRAIL_TICK_TOKEN as a bearer token. Without a token the route needs the
 * custom header x-checkrail-tick, which a cross-site form cannot send.
 */
export async function POST(req: Request) {
  const token = process.env.CHECKRAIL_TICK_TOKEN;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token ? !(bearer && safeEqual(bearer, token)) : req.headers.get("x-checkrail-tick") !== "1") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json(await runAutopilot(getDb()));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
