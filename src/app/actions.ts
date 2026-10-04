"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { amendObligation, approveObligation, confirmSettlement, executeObligation, ingestObligation, rejectObligation } from "@/lib/engine/orchestrator";
import { ACTOR_HEADER } from "@/lib/basicAuth";
import { isLiveRails } from "@/lib/config";
import { exportPendingCsv } from "@/lib/accounting/record";
import { seedDemo } from "@/lib/demo/seed";
import type { Rail, SourceType } from "@/lib/domain/types";

/**
 * Server actions: the only write surface of the UI. Each one calls the
 * orchestrator; none of them talks to a rail directly. The demo operator is
 * "user:daniel" unless DUELINE_BASIC_AUTH is set, in which case the middleware
 * authenticates every request and the username becomes the actor (this is a single
 * shared credential, not RBAC).
 */

const DEMO_ACTOR = "user:daniel";

/** The acting user for this request. The header is only trusted when Basic auth is configured: the middleware sets it itself. */
async function actor(): Promise<string> {
  if (!process.env.DUELINE_BASIC_AUTH) return DEMO_ACTOR;
  const user = (await headers()).get(ACTOR_HEADER);
  if (!user) throw new Error("Not authenticated");
  return `user:${user}`;
}

function done(paths: string[] = ["/", "/obligations", "/ledger", "/accounting", "/vendors", "/exceptions", "/audit"]) {
  for (const p of paths) revalidatePath(p);
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approveAction(id: string, note?: string): Promise<ActionResult> {
  try {
    const out = approveObligation(getDb(), id, await actor(), note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: out.decision === "auto_execute" ? "Approved and ready to pay." : `Approval recorded. Policy says: ${out.decision.replace("_", " ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function rejectAction(id: string, note?: string): Promise<ActionResult> {
  try {
    rejectObligation(getDb(), id, await actor(), note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Obligation cancelled." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function executeAction(id: string, rail?: Rail): Promise<ActionResult> {
  try {
    const db = getDb();
    const r = await executeObligation(db, id, { actor: await actor(), rail });
    if (r.status === "submitted") await confirmSettlement(db, id, "post-execute");
    done([`/obligations/${id}`]);
    done();
    if (r.status === "unknown") return { ok: false, message: "The rail did not give a clear answer, so the payment may or may not have gone through. Do not pay again; it needs reconciling." };
    return r.status === "failed" ? { ok: false, message: "The rail rejected the payment. See the attempt log." } : { ok: true, message: "Payment executed." };
  } catch (e) {
    done([`/obligations/${id}`]);
    done();
    return { ok: false, message: (e as Error).message };
  }
}

export async function confirmAction(id: string): Promise<ActionResult> {
  try {
    const state = await confirmSettlement(getDb(), id, "manual");
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: `Settlement status: ${state}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function amendAction(id: string, patch: { amountMinor?: number; sourceRef?: string }, note?: string): Promise<ActionResult> {
  try {
    await amendObligation(getDb(), id, await actor(), patch, note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Obligation corrected and re-evaluated." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function ingestAction(input: { sourceType: SourceType; rawInput: string; evidence?: Array<{ kind: string; label: string; amountMinor: number | null; currency: string | null; reference: string | null; excerpt: string | null }> }): Promise<ActionResult & { id?: string }> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured. Run the demo seed first." };
    const id = await ingestObligation(db, { businessId: biz.id, sourceType: input.sourceType, rawInput: input.rawInput, evidence: input.evidence ?? [], actor: await actor(), evidenceSource: "operator" });
    done();
    return { ok: true, message: "Obligation created.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function exportCsvAction(): Promise<ActionResult & { csv?: string }> {
  try {
    const { csv, count } = exportPendingCsv(getDb());
    done(["/accounting"]);
    return { ok: true, message: `${count} record${count === 1 ? "" : "s"} exported.`, csv };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function resetDemoAction(): Promise<ActionResult> {
  try {
    // Resetting wipes obligations, payment attempts, settlements and the audit log. Never with real rails.
    if (isLiveRails()) return { ok: false, message: "Demo reset is disabled when RAIL_MODE=live." };
    await seedDemo(getDb(), { history: true });
    done();
    return { ok: true, message: "Demo reset. Four obligations are waiting: two will be blocked, one pays over PayPal, one needs approval." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
