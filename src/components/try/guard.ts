import { realMoneyEnv } from "@/lib/basicAuth";
import { isLiveAi, isLiveRails, isRealMoney } from "@/lib/config";
import { activeCopiedAt, activeSandboxId } from "@/lib/sandbox/server";

/**
 * Where Try it yourself may run: in a visitor's own sandbox copy of the demo, on simulated rails, with the rule-based
 * reader. Refused whenever a rail is live, real money could move, or the reader would call a model.
 */
export function tryRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (isLiveRails() || env.RAIL_MODE === "live") return "Try it yourself runs on simulated rails only, and the rails here are live.";
  if (isRealMoney() || realMoneyEnv(env)) return "Try it yourself is off wherever real money can move.";
  if (isLiveAi()) return "Try it yourself uses the rule-based reader, and this server is set to call a model.";
  if (!activeSandboxId()) return "Try it yourself runs in your own copy of the demo, and this browser has none. Reload the page to get one.";
  return null;
}

/** Requests one copy of the demo may create through Try it yourself, so it cannot be used to fill the disk. */
export const TRY_LIMIT_PER_COPY = 30;

/**
 * Counts per copy of the demo. A copy is its sandbox id plus when it was made, so Start over (a fresh copy under the
 * same id) starts the count again. Kept in memory: a server restart deletes every copy anyway.
 */
export class TryBudget {
  private used = new Map<string, number>();
  constructor(private readonly limit: number = TRY_LIMIT_PER_COPY) {}

  /** Takes one from this copy's budget; false when it is spent. */
  take(copy: string): boolean {
    const n = this.used.get(copy) ?? 0;
    if (n >= this.limit) return false;
    if (this.used.size > 5000) this.used.clear();
    this.used.set(copy, n + 1);
    return true;
  }

  left(copy: string): number {
    return Math.max(0, this.limit - (this.used.get(copy) ?? 0));
  }
}

const g = globalThis as typeof globalThis & { __checkrailTryBudget?: { requests: TryBudget; documents: TryBudget } };

/** One budget for new requests and one for attached documents, per server process. */
export function tryBudgets(): { requests: TryBudget; documents: TryBudget } {
  g.__checkrailTryBudget ??= { requests: new TryBudget(), documents: new TryBudget() };
  return g.__checkrailTryBudget;
}

/** The current visitor's copy, as a budget key. */
export function copyKey(): string | null {
  const id = activeSandboxId();
  return id ? `${id}:${activeCopiedAt() ?? 0}` : null;
}
