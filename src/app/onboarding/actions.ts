"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { isRole } from "@/lib/auth/roles";
import { resolveActor, type Actor } from "@/lib/engine/users";
import { runAs } from "@/lib/engine/requestContext";
import { getBusiness } from "@/lib/queries";
import type { Detection } from "@/lib/onboarding/detect";
import { createImport, detectForBusiness, getImport, type CreateImportInput, type ImportSummary } from "@/lib/onboarding/imports";
import { applySuggestion, dismissSuggestion, markCall, type ApplyInput, type ApplyResult, type MarkResult, type SuggestionView } from "@/lib/onboarding/calibration";
import { importCalls, onboardingDashboard, type CallRow, type DashboardData } from "@/lib/onboarding/dashboard";

/**
 * Server actions for the onboarding screens: bring in your data, check our calls against your history, and your
 * first weeks. Each one finds out who is signed in (the middleware sets the login or demo persona and its role on
 * every request) and the engine function it calls checks that role:
 *
 *   detectColumnsAction, createImportAction    ingest (owner, AP clerk)
 *   markCallAction                             approve (owner, approver)
 *   applySuggestionAction, dismissSuggestionAction
 *                                              verify_vendor for rate cards, suppliers and retainers (owner, approver);
 *                                              settings for a booking feed (owner)
 *   dashboardDataAction, importCallsAction     any signed-in person (reads only)
 *
 * None of them pays, schedules a payment, or changes a rule or a policy setting. Applying a rate card suggestion adds
 * the rate card through the same function as the supplier page, as the person who applied it.
 *
 * Every action returns { ok: true, message, data } or { ok: false, message }; it never throws to the page.
 */

export type OnboardingActionResult<T> = { ok: true; message: string; data: T } | { ok: false; message: string };

/** The real login (not a demo persona) is the request's person, so audit rows name it. Same as src/app/actions.ts. */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  let h: Awaited<ReturnType<typeof headers>> | null = null;
  try {
    h = await headers();
  } catch {
    h = null;
  }
  const login = !h || h.get("x-checkrail-public") === "1" ? null : h.get(PERSONA_HEADER) ?? h.get(ACTOR_HEADER);
  return runAs(login, fn);
}

/** The person signed in and their business. Refuses on the vendor-facing pages, which carry no login. */
async function signedIn(): Promise<{ actor: Actor; businessId: string }> {
  const h = await headers();
  if (h.get("x-checkrail-public") === "1") throw new Error("Not signed in");
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) throw new Error("Not signed in");
  const db = getDb();
  const biz = getBusiness(db);
  if (!biz) throw new Error("No business configured. Run the demo seed first.");
  return { actor: resolveActor(db, biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined), businessId: biz.id };
}

async function run<T>(fn: (who: { actor: Actor; businessId: string }) => Promise<{ data: T; message: string }> | { data: T; message: string }, changes = false): Promise<OnboardingActionResult<T>> {
  return inRequest(async () => {
    try {
      const out = await fn(await signedIn());
      if (changes) revalidatePath("/", "layout");
      return { ok: true as const, message: out.message, data: out.data };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  });
}

/** Screen 1: how to read an uploaded bank export (CSV text, 5 MB at most). Uses the mapping saved for its layout when there is one. */
export async function detectColumnsAction(csv: string): Promise<OnboardingActionResult<Detection>> {
  return run(({ actor, businessId }) => {
    const data = detectForBusiness(getDb(), businessId, actor, csv);
    return { data, message: data.fromSaved ? "Read with the mapping saved for this export." : data.missing.length ? `Choose the column for: ${data.missing.join(", ")}.` : "Columns found. Check them before re-checking." };
  });
}

/** Screen 1: create the import with the confirmed mapping and re-check its last 90 days. Returns the totals for screen 2. */
export async function createImportAction(input: CreateImportInput): Promise<OnboardingActionResult<ImportSummary>> {
  return run(async ({ actor, businessId }) => {
    if (!input || typeof input !== "object") throw new Error("Nothing to import");
    const data = await createImport(getDb(), businessId, actor, input);
    return { data, message: `Re-checked ${data.payments} payments from ${data.periodFrom} to ${data.periodTo}.` };
  }, true);
}

/** Screen 2: one import's totals, or null when it is not this business's. */
export async function getImportAction(importId: string): Promise<OnboardingActionResult<ImportSummary | null>> {
  return run(({ businessId }) => ({ data: typeof importId === "string" ? getImport(getDb(), businessId, importId) : null, message: "" }));
}

/** Screen 2: the calls of one import the owner marks (flagged rows, in file order). */
export async function importCallsAction(importId: string): Promise<OnboardingActionResult<CallRow[]>> {
  return run(({ businessId }) => ({ data: typeof importId === "string" ? importCalls(getDb(), businessId, importId) : [], message: "" }));
}

/** Screen 2: mark one call "right_catch" or "was_fine", with an optional note. Returns the suggestions now proposed. */
export async function markCallAction(callId: string, mark: "right_catch" | "was_fine", note?: string): Promise<OnboardingActionResult<MarkResult>> {
  return run(({ actor, businessId }) => {
    const data = markCall(getDb(), businessId, actor, callId, mark, note);
    return { data, message: mark === "right_catch" ? "Marked as a right catch." : "Marked as fine." };
  }, true);
}

/** Screen 2: apply a proposed suggestion. For a rate card, `input.rate` carries the values the person checked. */
export async function applySuggestionAction(suggestionId: string, input?: ApplyInput): Promise<OnboardingActionResult<ApplyResult>> {
  return run(({ actor, businessId }) => {
    const data = applySuggestion(getDb(), businessId, actor, suggestionId, input ?? {});
    return { data, message: data.message };
  }, true);
}

/** Screen 2: dismiss a proposed suggestion, with an optional note. */
export async function dismissSuggestionAction(suggestionId: string, note?: string): Promise<OnboardingActionResult<SuggestionView>> {
  return run(({ actor, businessId }) => ({ data: dismissSuggestion(getDb(), businessId, actor, suggestionId, note), message: "Suggestion dismissed." }), true);
}

/** Screen 3 (and 2): every widget's rows. Field names are documented in src/lib/onboarding/dashboard.ts. */
export async function dashboardDataAction(): Promise<OnboardingActionResult<DashboardData>> {
  return run(({ businessId }) => ({ data: onboardingDashboard(getDb(), businessId), message: "" }));
}
