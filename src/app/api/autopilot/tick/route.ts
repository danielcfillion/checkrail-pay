import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runAutopilot } from "@/lib/engine/autopilot";

export const dynamic = "force-dynamic";

/**
 * One autopilot pass, for an external scheduler (cron, a platform job) when the in-process
 * heartbeat is off. Sits behind the same Basic auth as the rest of the app. It takes no input:
 * a caller can only ask the agent to do what policy already allows, never direct a payment.
 */
export async function POST() {
  try {
    return NextResponse.json(await runAutopilot(getDb()));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
