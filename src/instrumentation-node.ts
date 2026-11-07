import { desc, like } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { auditEntries } from "@/lib/db/schema";
import { runAutopilot } from "@/lib/engine/autopilot";
import { purgeUnlinkedUploads } from "@/lib/engine/attachments";
import { seedDemo } from "@/lib/demo/seed";
import { isLiveRails } from "@/lib/config";
import { startSandboxes } from "@/lib/sandbox/server";
import { runXeroSyncInBackground } from "@/lib/accounting/xeroSync";

/**
 * Node-only half of the heartbeat (see instrumentation.ts). Kept separate so the edge bundle never sees the database driver.
 *
 * Sandbox mode (a private copy of the demo per browser, src/lib/sandbox/server.ts) is started here first. With it on,
 * there is no heartbeat over the shared database: autopilot runs per copy when that copy is used (and when a countdown
 * reaches zero), the idle reset is not needed because each copy is deleted after its own idle time, and sandbox mode
 * keeps its own housekeeping timer (deleting idle copies, reseeding the template at a quiet moment).
 */
export async function startHeartbeat(): Promise<void> {
  if (await startSandboxes()) return;
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
    // Books, beside the payment path: sends approved bills and settled payments to Xero when it is connected. Not
    // awaited, and the autopilot never waits for it.
    runXeroSyncInBackground(getDb());
    try {
      purgeUnlinkedUploads(getDb());
    } catch (e) {
      console.error("[uploads] purge failed:", (e as Error).message);
    }
    if (idleMinutes > 0 && !isLiveRails()) {
      try {
        const last = getDb().select({ at: auditEntries.createdAt }).from(auditEntries).where(like(auditEntries.actor, "user:%")).orderBy(desc(auditEntries.seq)).limit(1).get();
        const touched = last && last.at > (g.__checkrailSeededAt ?? "");
        if (touched && Date.now() - new Date(last!.at).getTime() > idleMinutes * 60_000) {
          g.__checkrailSeededAt = "9999"; // no second reset while this one runs
          seedDemo(getDb(), { history: true })
            .then(() => {
              // Stamp after seeding: the seed writes its own entries, which must not count as someone using the demo.
              g.__checkrailSeededAt = new Date().toISOString();
              console.log(`[demo] idle for ${idleMinutes} min after use; demo story restored`);
            })
            .catch((e) => console.error("[demo] auto reset failed:", (e as Error).message));
        }
      } catch (e) {
        console.error("[demo] idle check failed:", (e as Error).message);
      }
    }
  }, seconds * 1000);
  g.__checkrailHeartbeat.unref?.();
}
