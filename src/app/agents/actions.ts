"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { isRole } from "@/lib/auth/roles";
import { requirePermission, resolveActor, type Actor } from "@/lib/engine/users";
import { runAs } from "@/lib/engine/requestContext";
import { audit } from "@/lib/domain/stateMachine";
import { getBusiness } from "@/lib/queries";
import { issueMandate, revokeMandate, type IssueInput } from "@/lib/agent/mandates";

/**
 * Server actions for spending mandates on the Agents page. Issuing and revoking are the owner's: the settings
 * permission, like autonomy and caps. A mandate never pays or approves anything; it narrows what one agent may request.
 * Each returns { ok, message } and never throws to the page.
 */

export type MandateActionResult = { ok: true; message: string; token?: string } | { ok: false; message: string };

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

async function owner(what: string): Promise<{ actor: Actor; businessId: string }> {
  const h = await headers();
  if (h.get("x-checkrail-public") === "1") throw new Error("Not signed in");
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) throw new Error("Not signed in");
  const db = getDb();
  const biz = getBusiness(db);
  if (!biz) throw new Error("No business configured. Run the demo seed first.");
  const actor = resolveActor(db, biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined);
  requirePermission(actor, "settings", what);
  return { actor, businessId: biz.id };
}

export async function issueMandateAction(input: IssueInput): Promise<MandateActionResult> {
  return inRequest(async () => {
    try {
      const { actor, businessId } = await owner("issue spending mandates to agents");
      const row = issueMandate(getDb(), businessId, actor.id, input);
      audit(getDb(), { obligationId: null, actor: actor.id, action: "agent.mandate_issued", detail: { id: row.id, agent: row.agent, currency: row.currency, perPaymentMinor: row.perPaymentMinor, totalMinor: row.totalMinor, validUntil: row.validUntil } });
      revalidatePath("/agents");
      return { ok: true, message: `Mandate issued to ${row.agent}. Copy it and give it to that agent.`, token: row.token };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
}

export async function revokeMandateAction(id: string): Promise<MandateActionResult> {
  return inRequest(async () => {
    try {
      if (typeof id !== "string" || !/^mdt_[a-z0-9]{6,40}$/.test(id)) throw new Error("No such mandate");
      const { actor, businessId } = await owner("revoke spending mandates");
      revokeMandate(getDb(), businessId, id, actor.id);
      audit(getDb(), { obligationId: null, actor: actor.id, action: "agent.mandate_revoked", detail: { id } });
      revalidatePath("/agents");
      return { ok: true, message: "Mandate revoked. The agent can no longer request anything under it." };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
}
