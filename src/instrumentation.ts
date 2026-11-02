/**
 * Autopilot heartbeat. Runs one pass every few seconds inside the server process so scheduled
 * payments are released when their cancel window ends, with no browser open.
 * AUTOPILOT_HEARTBEAT=off disables it (use POST /api/autopilot/tick from a scheduler instead).
 * With autonomy at "review" or "assist" a pass only polls sent payments for settlement.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startHeartbeat } = await import("./instrumentation-node");
    await startHeartbeat();
  }
}
