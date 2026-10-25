"use server";


import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { eq } from "drizzle-orm";
import { obligations } from "@/lib/db/schema";
import { amendObligation, approveObligation, confirmSettlement, executeObligation, ingestObligation, rejectObligation, retryAmbiguousExecution, retryFailed, resolveManually } from "@/lib/engine/orchestrator";
import { ACTOR_HEADER, PERSONA_COOKIE, PERSONA_HEADER, ROLE_HEADER, configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { cookies } from "next/headers";
import { DEMO_PERSONAS, isRole, type Permission } from "@/lib/auth/roles";
import { resolveActor, requirePermission, updateTeamMember, type Actor, type TeamChange } from "@/lib/engine/users";
import { isLiveRails } from "@/lib/config";
import { exportPendingCsv } from "@/lib/accounting/record";
import { uploadDocument, type UploadResult } from "@/lib/engine/attachments";
import { seedDemo } from "@/lib/demo/seed";
import type { Rail, SourceType } from "@/lib/domain/types";
import { cancelAutopilotRelease, runAutopilot, setAutonomy, setAutopilotPaused, type AutonomyChange } from "@/lib/engine/autopilot";
import { signOffDailyClose } from "@/lib/engine/dailyClose";

/**
 * Server actions: the only write surface of the UI. Each one finds out who is acting (the middleware sets the
 * login or demo persona and its role on every request), checks that role may do this, and calls the
 * orchestrator. None of them talks to a rail directly. The engine checks approval limits and separation of
 * duties again, so a direct call cannot get around them.
 */

/** The acting person for this request. */
async function currentActor(): Promise<Actor> {
  const h = await headers();
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) throw new Error("Not signed in");
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  if (!biz) throw new Error("No business configured. Run the demo seed first.");
  return resolveActor(db, biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined);
}

/** The acting person, refused unless their role allows `p`. */
async function act(p: Permission, what: string): Promise<Actor> {
  const a = await currentActor();
  requirePermission(a, p, what);
  return a;
}


function done(paths: string[] = ["/", "/obligations", "/ledger", "/accounting", "/vendors", "/exceptions", "/audit", "/close", "/settings"]) {
  for (const p of paths) revalidatePath(p);
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function approveAction(id: string, note?: string, shownFingerprints?: string[]): Promise<ActionResult> {
  try {
    if (shownFingerprints && (!Array.isArray(shownFingerprints) || shownFingerprints.some((f) => typeof f !== "string" || f.length > 600))) throw new Error("Invalid page state");
    const out = approveObligation(getDb(), id, (await act("approve", "approve payments")).id, note, shownFingerprints);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: out.decision === "auto_execute" ? "Approved and ready to pay." : `Approval recorded. Policy says: ${out.decision.replace("_", " ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function rejectAction(id: string, note?: string): Promise<ActionResult> {
  try {
    // Turning down a payment that is waiting for approval is an approver's call; cancelling a blocked or held one is cleanup a clerk may do.
    const state = getDb().select({ state: obligations.state }).from(obligations).where(eq(obligations.id, id)).get()?.state;
    const who = state === "awaiting_approval" || state === "approved" ? await act("approve", "turn down a payment waiting for approval") : await act("amend", "cancel a request");
    rejectObligation(getDb(), id, who.id, note);
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
    const r = await executeObligation(db, id, { actor: (await act("pay", "send payments")).id, rail });
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

/** Resolve a payment whose rail outcome was unknown. Same key, never a new one. */
export async function reconcileAction(id: string): Promise<ActionResult> {
  try {
    const db = getDb();
    const r = await retryAmbiguousExecution(db, id, { actor: (await act("pay", "reconcile payments")).id });
    if (r.status === "submitted") await confirmSettlement(db, id, "post-reconcile");
    done([`/obligations/${id}`]);
    done();
    if (r.status === "unknown") return { ok: false, message: "Still no clear answer from the rail. Do not pay again; check the provider dashboard for this attempt's key." };
    if (r.status === "failed") return { ok: true, message: "The rail confirms nothing moved. The payment is marked failed and can be retried." };
    return { ok: true, message: "Found the original payment on the rail. Recorded as sent." };
  } catch (e) {
    done([`/obligations/${id}`]);
    return { ok: false, message: (e as Error).message };
  }
}

/** A person checked the provider dashboard for a payment with an unclear outcome. */
export async function resolveManuallyAction(id: string, found: string | null): Promise<ActionResult> {
  try {
    const who = (await act("resolve_stuck", "resolve a payment by hand")).id;
    const state = await resolveManually(getDb(), id, who, found ? { kind: "found", externalId: found } : { kind: "nothing_moved" });
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: state === "failed" ? "Recorded that nothing moved. You can retry the payment." : "Recorded the payout id. Checking settlement." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Move a definitively failed payment back to approved so it can be sent again. */
export async function retryFailedAction(id: string): Promise<ActionResult> {
  try {
    retryFailed(getDb(), id, (await act("pay", "retry payments")).id);
    done([`/obligations/${id}`]);
    return { ok: true, message: "Ready to retry." };
  } catch (e) {
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

export async function amendAction(id: string, patch: { amountMinor?: number; sourceRef?: string; vendorId?: string }, note?: string): Promise<ActionResult> {
  try {
    await amendObligation(getDb(), id, (await act("amend", "correct payment requests")).id, patch, note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Obligation corrected and re-evaluated." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function ingestAction(input: { sourceType: SourceType; rawInput: string; evidence?: Array<{ kind: string; label: string; amountMinor: number | null; currency: string | null; reference: string | null; excerpt: string | null; attachmentId?: string | null }> }): Promise<ActionResult & { id?: string }> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured. Run the demo seed first." };
    const id = await ingestObligation(db, { businessId: biz.id, sourceType: input.sourceType, rawInput: input.rawInput, evidence: input.evidence ?? [], actor: (await act("ingest", "create payment requests")).id, evidenceSource: "operator" });
    done();
    return { ok: true, message: "Obligation created.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function exportCsvAction(): Promise<ActionResult & { csv?: string }> {
  try {
    await act("export", "export accounting records");
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
    await act("reset_demo", "reset the demo");
    await seedDemo(getDb(), { history: true });
    done();
    return { ok: true, message: "Demo reset. Four obligations are waiting: two will be blocked, one pays over PayPal, one needs approval." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Upload a source document (PDF, image, text). It is read and stored; the proposed evidence rows come back for review. */
export async function uploadEvidenceAction(form: FormData): Promise<(ActionResult & { upload?: UploadResult })> {
  try {
    const file = form.get("file");
    if (!(file instanceof File)) return { ok: false, message: "No file received." };
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured. Run the demo seed first." };
    const bytes = Buffer.from(await file.arrayBuffer());
    const upload = await uploadDocument(db, { businessId: biz.id, name: file.name, mimeType: file.type, bytes, actor: (await act("ingest", "upload documents")).id });
    return { ok: true, message: upload.note ?? `Read ${upload.name} with ${upload.reader === "claude" ? "Claude" : upload.reader === "none" ? "no reader" : "the text reader"}.`, upload };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* Autonomy. Every change here is made by a signed-in person and lands in the audit log; the agent cannot call these. */

export async function setAutonomyAction(change: AutonomyChange): Promise<ActionResult> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    // People get at least a minute to cancel; a zero window exists only for tests and scripted demos.
    if (change.autopilotCancelWindowSeconds !== undefined && change.autopilotCancelWindowSeconds < 60) throw new Error("The cancel window must be at least 1 minute");
    const next = setAutonomy(db, biz.id, (await act("settings", "change autonomy and caps")).id, change);
    await runAutopilot(db, { businessId: biz.id }); // picks up anything already approved and clean
    done();
    const level = next.autonomy ?? "assist";
    return { ok: true, message: level === "autopilot" ? "Autopilot is on. Clean payments within your caps are sent after the cancel window." : level === "review" ? "Every payment now waits for a person." : "Clean small payments are pre-approved. A person sends them." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function pauseAutopilotAction(paused: boolean): Promise<ActionResult> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    // Anyone who may stop money can pause; resuming is a settings change.
    setAutopilotPaused(db, biz.id, (paused ? await act("stop", "pause autopilot") : await act("settings", "resume autopilot")).id, paused);
    if (!paused) await runAutopilot(db, { businessId: biz.id });
    done();
    return { ok: true, message: paused ? "Autopilot paused. Nothing will be sent without a person." : "Autopilot resumed." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function cancelReleaseAction(id: string): Promise<ActionResult> {
  try {
    cancelAutopilotRelease(getDb(), id, (await act("stop", "cancel a scheduled payment")).id);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Release cancelled. The payment stays approved and can be sent by hand." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Run one autopilot pass now. The heartbeat does this on its own; the UI calls it when a countdown reaches zero. */
export async function tickAutopilotAction(): Promise<ActionResult> {
  try {
    const r = await runAutopilot(getDb());
    done();
    return { ok: true, message: r.released.length ? `Autopilot sent ${r.released.length} payment${r.released.length === 1 ? "" : "s"}.` : "Nothing was due." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function signOffCloseAction(throughSeq: number): Promise<ActionResult> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    signOffDailyClose(db, biz.id, biz.baseCurrency, (await act("sign_off", "sign off the Daily close")).id, throughSeq);
    done();
    return { ok: true, message: "Signed off. The next close starts from here." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* Team and demo personas. */

/** Act as one of the demo team. Only takes effect where personas are allowed (never with real money); the middleware decides. */
export async function setPersonaAction(username: string | null): Promise<ActionResult> {
  const jar = await cookies();
  if (!username) {
    jar.delete(PERSONA_COOKIE);
    done();
    return { ok: true, message: "Back to your own login." };
  }
  const p = DEMO_PERSONAS.find((x) => x.username === username);
  if (!p) return { ok: false, message: "No such demo person." };
  if (!personasAllowed(process.env, (configuredUsers() ?? []).length > 0)) return { ok: false, message: "Demo people are off here." };
  const h = await headers();
  if (h.get(ROLE_HEADER) !== "admin" && !h.get(PERSONA_HEADER)) return { ok: false, message: "Only an owner login can act as someone else." };
  jar.set(PERSONA_COOKIE, p.username, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  done();
  return { ok: true, message: `Now acting as ${p.name}.` };
}

export async function updateTeamAction(change: TeamChange): Promise<ActionResult> {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    updateTeamMember(db, biz.id, await currentActor(), change);
    done(["/settings"]);
    return { ok: true, message: "Team updated." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
