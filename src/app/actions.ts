"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { amendObligation, approveObligation, confirmSettlement, executeObligation, ingestObligation, rejectObligation } from "@/lib/engine/orchestrator";
import { exportPendingCsv } from "@/lib/accounting/record";
import { seedDemo } from "@/lib/demo/seed";
import type { Rail, SourceType } from "@/lib/domain/types";

/**
 * Server actions: the only write surface of the UI. Each one calls the
 * orchestrator; none of them talks to a rail directly. The demo operator is
 * "user:daniel"; swap for real auth before anything touches live money.
 */

const ACTOR = "user:daniel";

function done(paths: string[] = ["/", "/obligations", "/ledger", "/accounting", "/vendors", "/exceptions", "/audit"]) {
  for (const p of paths) revalidatePath(p);
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approveAction(id: string, note?: string): Promise<ActionResult> {
  try {
    const out = approveObligation(getDb(), id, ACTOR, note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: out.decision === "auto_execute" ? "Approved and ready to pay." : `Approval recorded. Policy says: ${out.decision.replace("_", " ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function rejectAction(id: string, note?: string): Promise<ActionResult> {
  try {
    rejectObligation(getDb(), id, ACTOR, note);
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
    const r = await executeObligation(db, id, { actor: ACTOR, rail });
    if (r.status === "submitted") await confirmSettlement(db, id, "post-execute");
    done([`/obligations/${id}`]);
    done();
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
    await amendObligation(getDb(), id, ACTOR, patch, note);
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
    const id = await ingestObligation(db, { businessId: biz.id, sourceType: input.sourceType, rawInput: input.rawInput, evidence: input.evidence ?? [], actor: ACTOR });
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
    await seedDemo(getDb(), { history: true });
    done();
    return { ok: true, message: "Demo reset. Three live obligations are waiting in the inbox." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
