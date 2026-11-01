import { configuredUsers, personasAllowed, realMoneyEnv } from "@/lib/basicAuth";
import { isLiveRails } from "@/lib/config";
import { sandboxActive } from "@/lib/sandbox/server";

/** The judge tour is offered on the demo only: sandbox mode or the demo personas on, never with live rails or real money. */
export function tourEnabled(): boolean {
  if (isLiveRails() || realMoneyEnv(process.env)) return false;
  return sandboxActive() || personasAllowed(process.env, (configuredUsers() ?? []).length > 0);
}
