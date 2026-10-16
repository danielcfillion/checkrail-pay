import { desc, like } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { auditEntries } from "@/lib/db/schema";
import { runAutopilot } from "@/lib/engine/autopilot";
import { seedDemo } from "@/lib/demo/seed";
import { isLiveRails } from "@/lib/config";

/** Node-only half of the heartbeat (see instrumentation.ts). Kept separate so the edge bundle never sees the database driver. */
export function startHeartbeat(): void {
  if (process.env.AUTOPILOT_HEARTBEAT === "off") return;
  const g = globalThis as unknown as { __checkrailHeartbeat?: ReturnType<typeof setInterval>; __checkrailSeededAt?: string };
  if (g.__checkrailHeartbeat) return;
  const seconds = Math.max(5, Number(process.env.AUTOPILOT_HEARTBEAT_SECONDS) || 15);
  // Hosted judging demo: one shared database. After this many minutes with no one using it, put the demo story back,
  // so each judge who arrives later starts from the four opening requests. Off unless set; never with live rails.
  const idleMinutes = Number(process.env.DEMO_AUTO_RESET_MINUTES) || 0;
  g.__checkrailSeededAt = new Date().toISOString();
  g.__checkrailHeartbeat = setInterval(() => {
    runAutopilot(getDb()).catch((e) => console.error("[autopilot] pass failed:", (e as Error).message));
    if (idleMinutes > 0 && !isLiveRails()) {
      try {
        const last = getDb().select({ at: auditEntries.createdAt }).from(auditEntries).where(like(auditEntries.actor, "user:%")).orderBy(desc(auditEntries.seq)).limit(1).get();
        const touched = last && last.at > (g.__checkrailSeededAt ?? "");
        if (touched && Date.now() - new Date(last!.at).getTime() > idleMinutes * 60_000) {
          g.__checkrailSeededAt = new Date().toISOString();
          seedDemo(getDb(), { history: true })
            .then(() => console.log(`[demo] idle for ${idleMinutes} min after use; demo story restored`))
            .catch((e) => console.error("[demo] auto reset failed:", (e as Error).message));
        }
      } catch (e) {
        console.error("[demo] idle check failed:", (e as Error).message);
      }
    }
  }, seconds * 1000);
  g.__checkrailHeartbeat.unref?.();
}
