"use server";


import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { businesses, obligations, paymentRunItems, paymentRuns, vendorChanges } from "@/lib/db/schema";
import { audit } from "@/lib/domain/stateMachine";
import { amendObligation, approveObligation, assertOwnObligation, recheckObligation, recheckVendorItems, refreshQuotesIfStale, repayRefunded, setObligationDates, confirmSettlement, executeObligation, ingestObligation, linkWaitingToBill, rejectObligation, retryAmbiguousExecution, retryFailed, resolveManually } from "@/lib/engine/orchestrator";
import { ACTOR_HEADER, PERSONA_COOKIE, PERSONA_HEADER, ROLE_HEADER, configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { cookies } from "next/headers";
import { DEMO_PERSONAS, isRole, type Permission } from "@/lib/auth/roles";
import { resolveActor, requirePermission, updateTeamMember, type Actor, type TeamChange } from "@/lib/engine/users";
import { config, isLiveRails } from "@/lib/config";
import { fetchPayPalStatement, livePayPalGetJson } from "@/lib/rails/paypalStatement";
import { runAs } from "@/lib/engine/requestContext";
import { exportPendingCsv } from "@/lib/accounting/record";
import { exportNewXeroBills } from "@/lib/accounting/xeroBills";
import { uploadDocument, type UploadResult } from "@/lib/engine/attachments";
import { seedDemo } from "@/lib/demo/seed";
import type { Rail, SourceType } from "@/lib/domain/types";
import { cancelAutopilotRelease, runAutopilot, setAutonomy, setAutopilotPaused, type AutonomyChange } from "@/lib/engine/autopilot";
import { signOffDailyClose } from "@/lib/engine/dailyClose";
import { cancelRun, createRun, releaseRun, removeRunItem } from "@/lib/engine/runs";
import { confirmBatch, returnLine } from "@/lib/engine/bankFiles";
import { applyCredit, createBill, payBill, settleAdvance, voidBill } from "@/lib/engine/bills";
import { setRate } from "@/lib/engine/rates";
import { importDeparturesAndRecheck } from "@/lib/engine/manifest";
import { markReturnedByHand, parsePayPalCsv, reconcilePayPal, setPeriodLock } from "@/lib/engine/books";
import { createEvidenceRequest, createRemittanceLink, remittanceMessage, remittanceMessageFor, viewRemittance } from "@/lib/engine/vendorLinks";
import { createInvite, createVendor, proposePayoutChange, rejectVendorChange, setVendorStatus, updateVendorProfile, verifyVendorChange } from "@/lib/engine/vendors";

/**
 * Server actions: the only write surface of the UI. Each one finds out who is acting (the middleware sets the
 * login or demo persona and its role on every request), checks that role may do this, and calls the
 * orchestrator. None of them talks to a rail directly. The engine checks approval limits and separation of
 * duties again, so a direct call cannot get around them.
 */

/**
 * Every action below runs inside this: the real login (not a demo persona) is the request's person, so audit rows
 * name it and "another person" for dual approval, separation of duties and maker-checker means another login.
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  // Outside a request (a script, a test) there is no login; the action's own sign-in check then refuses as usual.
  let h: Awaited<ReturnType<typeof headers>> | null = null;
  try {
    h = await headers();
  } catch {
    h = null;
  }
  // With a demo persona active the actor header names the persona and the persona header names the real login.
  const login = !h || h.get("x-checkrail-public") === "1" ? null : h.get(PERSONA_HEADER) ?? h.get(ACTOR_HEADER);
  return runAs(login, fn);
}

/** The acting person for this request. */
async function currentActor(): Promise<Actor> {
  const h = await headers();
  // Server actions can be posted to any page, including the vendor-facing ones that need no login. The middleware
  // strips identity there; refuse outright too, so no internal action ever runs for a token holder.
  if (h.get("x-checkrail-public") === "1") throw new Error("Not signed in");
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) throw new Error("Not signed in");
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  if (!biz) throw new Error("No business configured. Run the demo seed first.");
  const actor = resolveActor(db, biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined);
  return actor;
}

/** The acting person on one obligation: refused unless it belongs to their business and their role allows `p`. */
async function actOn(id: string, p: Permission | null, what: string): Promise<Actor> {
  const a = p ? await act(p, what) : await currentActor();
  const biz = await getDb().query.businesses.findFirst();
  assertOwnObligation(getDb(), biz!.id, id);
  return a;
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

export async function approveAction(id: string, note: string | undefined, shownFingerprints: string[]): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    // The page always sends the warnings it showed (an empty list when it showed none). A call without one is not a page:
    // it would let the last evaluation on record stand in for what the person saw.
    if (!Array.isArray(shownFingerprints) || shownFingerprints.some((f) => typeof f !== "string" || f.length > 600)) throw new Error("Invalid page state");
    const out = approveObligation(getDb(), id, (await actOn(id, "approve", "approve payments")).id, note, shownFingerprints);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: out.decision === "auto_execute" ? "Approved and ready to pay." : `Approval recorded. Policy says: ${out.decision.replace("_", " ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function rejectAction(id: string, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    // Turning down a payment that is waiting for approval is an approver's call; cancelling a blocked or held one is cleanup a clerk may do.
    const state = getDb().select({ state: obligations.state }).from(obligations).where(eq(obligations.id, id)).get()?.state;
    const who = state === "awaiting_approval" || state === "approved" ? await actOn(id, "approve", "turn down a payment waiting for approval") : await actOn(id, "amend", "cancel a request");
    rejectObligation(getDb(), id, who.id, note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Request cancelled." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function executeAction(id: string, rail?: Rail): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const r = await executeObligation(db, id, { actor: (await actOn(id, "pay", "send payments")).id, rail });
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
  });
}

/** Resolve a payment whose rail outcome was unknown. Same key, never a new one. */
export async function reconcileAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const r = await retryAmbiguousExecution(db, id, { actor: (await actOn(id, "pay", "reconcile payments")).id });
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
  });
}

/** A person checked the provider dashboard for a payment with an unclear outcome. */
export async function resolveManuallyAction(id: string, found: string | null): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const who = (await actOn(id, "resolve_stuck", "resolve a payment by hand")).id;
    const state = await resolveManually(getDb(), id, who, found ? { kind: "found", externalId: found } : { kind: "nothing_moved" });
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: state === "failed" ? "Recorded that nothing moved. You can retry the payment." : "Recorded the payout id. Checking settlement." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Move a definitively failed payment back to approved so it can be sent again. */
export async function retryFailedAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    retryFailed(getDb(), id, (await actOn(id, "pay", "retry payments")).id);
    done([`/obligations/${id}`]);
    return { ok: true, message: "Ready to retry." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function confirmAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await actOn(id, null, "check settlement");
    const state = await confirmSettlement(getDb(), id, "manual");
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: `Settlement status: ${state}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Invoice and due dates: they decide when a payment is due and what the books show, not what is paid. */
export async function setDatesAction(id: string, dates: { invoiceDate: string | null; dueDate: string | null }): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const r = setObligationDates(getDb(), id, (await actOn(id, "amend", "change invoice dates")).id, { invoiceDate: dates?.invoiceDate ?? null, dueDate: dates?.dueDate ?? null });
    done([`/obligations/${id}`, "/runs", "/books", "/accounting"]);
    return { ok: true, message: r.changedAfterExport ? "Dates saved. This bill is already in Xero with the old dates: change it there too (it is listed on the Accounting page)." : "Dates saved." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** A payment that came back: request it again, through every check. */
export async function repayAction(id: string): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const newId = await repayRefunded(getDb(), id, (await actOn(id, "ingest", "request payments")).id);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Requested again. It goes through every check like a new payment.", id: newId };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Record that a payout came back, after checking it in PayPal (a reversal the statement could not tie). */
export async function markReturnedAction(id: string, statementRef: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const who = await actOn(id, "reconcile", "record money that came back");
    const biz = await getDb().query.businesses.findFirst();
    markReturnedByHand(getDb(), biz!.id, who, id, typeof statementRef === "string" ? statementRef : "");
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Recorded as come back. The vendor is owed again." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Quote every rail again (a rail was set up since, or the quotes are old). */
export async function requoteAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await actOn(id, "pay", "quote payments again");
    await refreshQuotesIfStale(getDb(), id, 0);
    done([`/obligations/${id}`]);
    return { ok: true, message: "Quoted again on every rail." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Run the checks again after something outside the request was fixed (details verified, a rate card added). */
export async function recheckAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const state = await recheckObligation(getDb(), id, (await actOn(id, "amend", "check payments again")).id);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: state === "blocked" ? "Checked again: still blocked. The reason is shown above." : `Checked again: now ${state.replace(/_/g, " ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function amendAction(id: string, patch: { amountMinor?: number; sourceRef?: string; vendorId?: string }, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await amendObligation(getDb(), id, (await actOn(id, "amend", "correct payment requests")).id, patch, note);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Request corrected and checked again." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function ingestAction(input: { sourceType: SourceType; rawInput: string; evidence?: Array<{ kind: string; label: string; amountMinor: number | null; currency: string | null; reference: string | null; excerpt: string | null; attachmentId?: string | null }> }): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured. Run the demo seed first." };
    const id = await ingestObligation(db, { businessId: biz.id, sourceType: input.sourceType, rawInput: input.rawInput, evidence: input.evidence ?? [], actor: (await act("ingest", "create payment requests")).id, evidenceSource: "operator" });
    done();
    return { ok: true, message: "Request created.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function exportCsvAction(): Promise<ActionResult & { csv?: string }> {
  return inRequest(async () => {
  try {
    await act("export", "export accounting records");
    const { csv, count } = exportPendingCsv(getDb());
    done(["/accounting"]);
    return { ok: true, message: `${count} record${count === 1 ? "" : "s"} exported.`, csv };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function resetDemoAction(): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    // Resetting wipes obligations, payment attempts, settlements and the audit log. Never with real rails.
    if (isLiveRails()) return { ok: false, message: "Demo reset is disabled when RAIL_MODE=live." };
    await act("reset_demo", "reset the demo");
    await seedDemo(getDb(), { history: true });
    done();
    return { ok: true, message: "Demo reset. Four requests are waiting: two are blocked, one is ready to pay over PayPal, one needs approval." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Upload a source document (PDF, image, text). It is read and stored; the proposed evidence rows come back for review. */
export async function uploadEvidenceAction(form: FormData): Promise<(ActionResult & { upload?: UploadResult })> {
  return inRequest(async () => {
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
  });
}

/* Autonomy. Every change here is made by a signed-in person and lands in the audit log; the agent cannot call these. */

export async function setAutonomyAction(change: AutonomyChange): Promise<ActionResult> {
  return inRequest(async () => {
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
    return { ok: true, message: level === "autopilot" ? "Autopilot is on. Payments the rules pass, within your caps, are sent after the cancel window." : level === "review" ? "Every payment now waits for a person." : "Small payments the rules pass are pre-approved. A person sends them." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function pauseAutopilotAction(paused: boolean): Promise<ActionResult> {
  return inRequest(async () => {
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
  });
}

export async function cancelReleaseAction(id: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    cancelAutopilotRelease(getDb(), id, (await actOn(id, "stop", "cancel a scheduled payment")).id);
    done([`/obligations/${id}`]);
    done();
    return { ok: true, message: "Release cancelled. The payment stays approved and can be sent by hand." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Run one autopilot pass now. The heartbeat does this on its own; the UI calls it when a countdown reaches zero. */
export async function tickAutopilotAction(): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await currentActor();
    const r = await runAutopilot(getDb());
    done();
    return { ok: true, message: r.released.length ? `Autopilot sent ${r.released.length} payment${r.released.length === 1 ? "" : "s"}.` : "Nothing was due." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function signOffCloseAction(throughSeq: number): Promise<ActionResult> {
  return inRequest(async () => {
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
  });
}

/* Team and demo personas. */

/** Act as one of the demo team. Only takes effect where personas are allowed (never with real money); the middleware decides. */
export async function setPersonaAction(username: string | null): Promise<ActionResult> {
  return inRequest(async () => {
  if ((await headers()).get("x-checkrail-public") === "1") return { ok: false, message: "Not signed in" };
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
  });
}

export async function updateTeamAction(change: TeamChange): Promise<ActionResult> {
  return inRequest(async () => {
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
  });
}

/* Vendor master. Payout details change only through a verified request; see lib/engine/vendors.ts. */

async function withBusiness<T>(fn: (db: ReturnType<typeof getDb>, businessId: string, who: Actor) => T): Promise<T> {
  const db = getDb();
  const biz = await db.query.businesses.findFirst();
  if (!biz) throw new Error("No business configured.");
  return fn(db, biz.id, await currentActor());
}

export async function createVendorAction(profile: unknown, payout: unknown): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const id = await withBusiness((db, b, who) => createVendor(db, b, who, profile, payout));
    done(["/vendors", `/vendors/${id}`]);
    return { ok: true, message: "Vendor added. Someone else verifies the payout details before the first payment.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function updateVendorAction(vendorId: string, profile: unknown): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness(async (db, b, who) => {
      updateVendorProfile(db, b, who, vendorId, profile);
      // Tax status or country may have changed what is kept back: waiting payments are checked and quoted again.
      await recheckVendorItems(db, b, vendorId, who.id);
      const approved = db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.businessId, b), eq(obligations.vendorId, vendorId), eq(obligations.state, "approved"))).all();
      for (const o of approved) await refreshQuotesIfStale(db, o.id, 0);
    });
    done(["/vendors", `/vendors/${vendorId}`]);
    done();
    return { ok: true, message: "Vendor details saved." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function proposePayoutAction(vendorId: string, payout: unknown, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => proposePayoutChange(db, b, who, vendorId, payout, typeof note === "string" ? note.slice(0, 300) : undefined));
    done(["/vendors", `/vendors/${vendorId}`]);
    return { ok: true, message: "Requested. The current details keep working until someone else verifies the new ones." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function verifyVendorChangeAction(changeId: string, method: string, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const rechecked = await withBusiness(async (db, b, who) => {
      verifyVendorChange(db, b, who, changeId, method, typeof note === "string" ? note.slice(0, 300) : undefined);
      // Their payments that were waiting on unverified details are checked again now, not left blocked.
      const vendorId = db.select({ v: vendorChanges.vendorId }).from(vendorChanges).where(eq(vendorChanges.id, changeId)).get()?.v;
      return vendorId ? recheckVendorItems(db, b, vendorId, who.id) : 0;
    });
    done();
    return { ok: true, message: `Verified. Payments use these details from now on.${rechecked ? ` ${rechecked} waiting payment${rechecked === 1 ? " was" : "s were"} checked again.` : ""}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function rejectVendorChangeAction(changeId: string, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => rejectVendorChange(db, b, who, changeId, typeof note === "string" ? note.slice(0, 300) : undefined));
    done(["/vendors"]);
    return { ok: true, message: "Turned down. Nothing changed." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function setVendorStatusAction(vendorId: string, status: "active" | "blocked", reason: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    if (status !== "active" && status !== "blocked") throw new Error("Unknown status");
    await withBusiness((db, b, who) => setVendorStatus(db, b, who, vendorId, status, reason));
    done();
    return { ok: true, message: status === "blocked" ? "Blocked. No payment goes to this vendor until someone unblocks them." : "Unblocked." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Returns the link once. Only its hash is kept, so it cannot be shown again. */
export async function createInviteAction(opts: { vendorId?: string | null; label?: string | null }): Promise<ActionResult & { path?: string; expiresAt?: string }> {
  return inRequest(async () => {
  try {
    const r = await withBusiness((db, b, who) => createInvite(db, b, who, { vendorId: typeof opts?.vendorId === "string" ? opts.vendorId : null, label: typeof opts?.label === "string" ? opts.label : null }));
    return { ok: true, message: "Link created. Copy it now: it is shown only once.", path: `/onboard/${r.token}`, expiresAt: r.expiresAt };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Payment runs. */

export async function createRunAction(name: string, obligationIds: string[]): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const id = await withBusiness((db, b, who) => createRun(db, b, who, { name, obligationIds }));
    done(["/runs"]);
    return { ok: true, message: "Run created. An approver reviews and releases it.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function removeRunItemAction(runId: string, itemId: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => removeRunItem(db, b, who, runId, itemId));
    done([`/runs/${runId}`, "/runs"]);
    return { ok: true, message: "Removed from the run." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function cancelRunAction(runId: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => cancelRun(db, b, who, runId));
    done(["/runs", `/runs/${runId}`]);
    return { ok: true, message: "Run cancelled. Nothing was paid." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function releaseRunAction(runId: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const r = await releaseRun(db, biz.id, await currentActor(), runId);
    done();
    done([`/runs/${runId}`, "/runs"]);
    const parts = [`${r.paid} paid`, r.with_bank ? `${r.with_bank} in the bank file (upload and confirm it on Bank files)` : "", r.skipped ? `${r.skipped} skipped` : "", r.failed ? `${r.failed} failed` : "", r.unclear ? `${r.unclear} unclear` : ""].filter(Boolean);
    return { ok: r.failed === 0 && r.unclear === 0, message: `Run released: ${parts.join(", ")}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Bank files. */

export async function confirmBankFileAction(batchId: string, bankRef: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const n = await confirmBatch(db, biz.id, await currentActor(), batchId, typeof bankRef === "string" ? bankRef : "");
    done();
    done(["/bank-files"]);
    return { ok: true, message: `Confirmed. ${n} payment${n === 1 ? "" : "s"} settled.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function returnBankLineAction(lineId: string, reason: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    await returnLine(db, biz.id, await currentActor(), lineId, typeof reason === "string" ? reason : "");
    done();
    done(["/bank-files"]);
    return { ok: true, message: "Recorded as returned. The payment failed and can be retried or cancelled." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Bills: invoices paid in parts, credit notes, advances. */

export async function createBillAction(vendorId: string, bill: { kind: string; reference: string; totalMinor: number; currency: string; dueDate?: string | null; note?: string | null }): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const id = await withBusiness(async (db, b, who) => {
      const made = createBill(db, b, who, vendorId, bill);
      // Requests from outside callers that already name this bill are put on it and checked again (API review R7-S4).
      await linkWaitingToBill(db, made, who.id);
      return made;
    });
    done([`/vendors/${vendorId}`]);
    return { ok: true, message: "Recorded.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function payBillAction(billId: string, amountMinor: number, note?: string): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const id = await payBill(db, biz.id, await currentActor(), billId, amountMinor, typeof note === "string" ? note : undefined);
    done();
    return { ok: true, message: "Payment request created. It goes through the usual checks.", id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function applyCreditAction(creditBillId: string, billId: string, amountMinor: number): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => applyCredit(db, b, who, creditBillId, billId, amountMinor));
    done(["/vendors"]);
    return { ok: true, message: "Credit applied." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function settleAdvanceAction(advanceBillId: string, receiptsMinor: number, note?: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const r = await withBusiness((db, b, who) => settleAdvance(db, b, who, advanceBillId, receiptsMinor, typeof note === "string" ? note : undefined));
    done(["/vendors"]);
    return { ok: true, message: r.owedTo === "vendor" ? "Settled. The overspend is recorded as owed to the vendor." : r.owedTo === "business" ? "Settled. The unspent part is a credit to set against their next bill." : "Settled exactly." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function voidBillAction(billId: string, reason: string): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => voidBill(db, b, who, billId, typeof reason === "string" ? reason : ""));
    done(["/vendors"]);
    return { ok: true, message: "Voided." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Rate cards and departures. */

export async function setRateAction(vendorId: string, rate: { unit: string; rateMinor: number; currency: string; validFrom: string; validTo?: string | null; note?: string | null }): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const n = await withBusiness(async (db, b, who) => {
      setRate(db, b, who, vendorId, rate);
      return recheckVendorItems(db, b, vendorId, who.id);
    });
    done([`/vendors/${vendorId}`, "/departures"]);
    done();
    return { ok: true, message: `Rate saved. Invoices for this vendor are checked against it from now on${n ? `; ${n} waiting payment${n === 1 ? " was" : "s were"} checked again` : ""}.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function importDeparturesAction(csv: string): Promise<ActionResult & { errors?: string[] }> {
  return inRequest(async () => {
  try {
    if (typeof csv !== "string") throw new Error("Choose a CSV file");
    const r = await withBusiness((db, b, who) => importDeparturesAndRecheck(db, b, who, csv));
    done();
    return { ok: true, message: `Imported ${r.departures} departure${r.departures === 1 ? "" : "s"} with ${r.services} service${r.services === 1 ? "" : "s"}${r.errors.length ? `; ${r.errors.length} line${r.errors.length === 1 ? "" : "s"} skipped` : ""}${r.rechecked ? `. ${r.rechecked} waiting payment${r.rechecked === 1 ? " was" : "s were"} checked again${r.nowBlocked ? `, ${r.nowBlocked} now blocked by the rate card` : ""}${r.nowReady ? `, ${r.nowReady} now ready to pay without a person because the rate card confirms ${r.nowReady === 1 ? "it" : "them"}` : ""}` : ""}.`, errors: r.errors };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function exportXeroBillsAction(): Promise<ActionResult & { csv?: string }> {
  return inRequest(async () => {
  try {
    const who = await act("export", "export bills");
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const { csv, count } = exportNewXeroBills(db, biz.id, who.id);
    done(["/accounting"]);
    return { ok: true, message: count ? `${count} bill${count === 1 ? "" : "s"} in the file. In Xero: Business, Bills to pay, Import.` : "No new bills since the last export.", csv: count ? csv : undefined };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Books: statement reconciliation and period lock. */

export async function reconcilePayPalAction(fileName: string, csv: string): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    if (typeof csv !== "string") throw new Error("Choose the PayPal activity CSV");
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const { id, result } = reconcilePayPal(db, biz.id, await currentActor(), parsePayPalCsv(csv), typeof fileName === "string" ? fileName : undefined);
    done(["/books", "/ledger"]);
    return { ok: true, message: `${result.matched.length} matched, ${result.statementOnly.length} on the statement only, ${result.appOnly.length} recorded here but not on the statement.${result.recorded === false ? " Shown to you, not saved: someone who reconciles (the accountant, an approver or the owner) saves matches." : ""}`, id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Pull the statement straight from PayPal Transaction Search (live rails only) and reconcile it. */
export async function reconcilePayPalLiveAction(from: string, to: string): Promise<ActionResult & { id?: string }> {
  return inRequest(async () => {
  try {
    if (!isLiveRails()) return { ok: false, message: "Reading the statement from PayPal needs live rails (RAIL_MODE=live with PayPal keys). Here, upload the activity CSV instead." };
    const { clientId, clientSecret, env } = config.rails.paypal;
    if (!clientId || !clientSecret) return { ok: false, message: "PayPal keys are not set." };
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const actor = await currentActor();
    const lines = await fetchPayPalStatement(await livePayPalGetJson(clientId, clientSecret, env), String(from), String(to));
    const { id, result } = reconcilePayPal(db, biz.id, actor, lines, `PayPal Transaction Search ${from} to ${to}`, "paypal_api");
    done(["/books", "/ledger"]);
    const back = result.returned?.length ? `, ${result.returned.length} came back` : "";
    return { ok: true, message: `Read ${lines.length} PayPal transactions: ${result.matched.length} matched${back}, ${result.statementOnly.length} on PayPal only, ${result.appOnly.length} recorded here but not on PayPal.`, id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function setPeriodLockAction(through: string | null): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    await withBusiness((db, b, who) => setPeriodLock(db, b, who, through || null));
    done(["/books"]);
    return { ok: true, message: through ? `Books closed through ${through}.` : "Period reopened." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/* Vendor links: remittance advice and evidence requests. */

export async function createVendorLinkAction(kind: "remittance" | "evidence", obligationId: string, note?: string): Promise<ActionResult & { path?: string; text?: string }> {
  return inRequest(async () => {
  try {
    if (kind !== "remittance" && kind !== "evidence") throw new Error("Unknown link");
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const who = await currentActor();
    if (kind === "remittance") {
      const token = createRemittanceLink(db, biz.id, who, obligationId);
      const r = viewRemittance(db, token)!;
      return { ok: true, message: "Remittance link ready. Copy it now: it is shown once.", path: `/remit/${token}`, text: remittanceMessage(r, "{link}") };
    }
    const token = createEvidenceRequest(db, biz.id, who, obligationId, typeof note === "string" ? note : null);
    done([`/obligations/${obligationId}`]);
    return { ok: true, message: "Evidence request ready. Copy it now: it is shown once.", path: `/evidence/${token}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

/** Remittance advice for every payment a released run sent: one message per vendor to paste into their channel. */
export async function runRemittancesAction(runId: string): Promise<ActionResult & { items?: Array<{ vendorName: string; paths: string[]; text: string }> }> {
  return inRequest(async () => {
  try {
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const who = await currentActor();
    const run = db.select().from(paymentRuns).where(and(eq(paymentRuns.id, runId), eq(paymentRuns.businessId, biz.id))).get();
    if (!run || run.status !== "released") throw new Error("Remittance advice is for a released run");
    const items = db.select().from(paymentRunItems).where(eq(paymentRunItems.runId, runId)).all().filter((i) => i.status === "paid" || i.status === "with_bank");
    // One message per vendor: their payments in this run, each with its own link.
    const byVendor = new Map<string, Array<{ r: NonNullable<ReturnType<typeof viewRemittance>>; path: string }>>();
    for (const i of items) {
      const token = createRemittanceLink(db, biz.id, who, i.obligationId);
      const r = viewRemittance(db, token)!;
      byVendor.set(r.vendorName, [...(byVendor.get(r.vendorName) ?? []), { r, path: `/remit/${token}` }]);
    }
    const out: Array<{ vendorName: string; paths: string[]; text: string }> = [];
    for (const [vendorName, list] of byVendor) out.push({ vendorName, paths: list.map((x) => x.path), text: remittanceMessageFor(list.map((x) => x.r), list.map((_, n) => `{link${n}}`)) });
    return { ok: true, message: `${out.length} remittance message${out.length === 1 ? "" : "s"} ready. Copy them now: each link is shown once.`, items: out };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}

export async function setTaxSettingsAction(change: { withholdVnPit: boolean; withholdPhEwt: boolean }): Promise<ActionResult> {
  return inRequest(async () => {
  try {
    const who = await act("settings", "change tax settings");
    const db = getDb();
    const biz = await db.query.businesses.findFirst();
    if (!biz) return { ok: false, message: "No business configured." };
    const policy = JSON.parse(biz.policyJson) as Record<string, unknown>;
    const next = { ...policy, withholdVnPit: change?.withholdVnPit === true, withholdPhEwt: change?.withholdPhEwt === true };
    db.update(businesses).set({ policyJson: JSON.stringify(next) }).where(eq(businesses.id, biz.id)).run();
    audit(db, { obligationId: null, actor: who.id, action: "settings.tax_changed", detail: { withholdVnPit: next.withholdVnPit, withholdPhEwt: next.withholdPhEwt } });
    done(["/settings"]);
    return { ok: true, message: "Tax settings saved. They apply from the next check of each payment." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  });
}
