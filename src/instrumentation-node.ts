import { getDb } from "@/lib/db";
import { runAutopilot } from "@/lib/engine/autopilot";

/** Node-only half of the heartbeat (see instrumentation.ts). Kept separate so the edge bundle never sees the database driver. */
export function startHeartbeat(): void {
  if (process.env.AUTOPILOT_HEARTBEAT === "off") return;
  const g = globalThis as unknown as { __checkrailHeartbeat?: ReturnType<typeof setInterval> };
  if (g.__checkrailHeartbeat) return;
  const seconds = Math.max(5, Number(process.env.AUTOPILOT_HEARTBEAT_SECONDS) || 15);
  g.__checkrailHeartbeat = setInterval(() => {
    runAutopilot(getDb()).catch((e) => console.error("[autopilot] pass failed:", (e as Error).message));
  }, seconds * 1000);
  g.__checkrailHeartbeat.unref?.();
}
