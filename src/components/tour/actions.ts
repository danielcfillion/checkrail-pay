"use server";

import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { businesses, obligations } from "@/lib/db/schema";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { isRole } from "@/lib/auth/roles";
import { requirePermission, resolveActor, type Actor } from "@/lib/engine/users";
import { runAs } from "@/lib/engine/requestContext";
import { uploadDocument } from "@/lib/engine/attachments";
import { ingestObligation } from "@/lib/engine/orchestrator";
import { runAutopilot, setAutonomy } from "@/lib/engine/autopilot";
import { handleMcp } from "@/lib/agent/mcp";
import { sandboxActive } from "@/lib/sandbox/server";
import { tourEnabled } from "./enabled";
import type { Permission } from "@/lib/auth/roles";
import pkg from "../../../package.json";

/**
 * The two things the judge tour does from its own card, through the same code paths as the product:
 *  - step 5 turns Autopilot on (setAutonomy, then an autopilot pass, as Settings does), first bringing in Rosa's trip
 *    completion sheet the way New request does if it is not there yet, so there is a payment to schedule;
 *  - step 6 has a demo agent ask check_payment through the MCP handler itself, so a judge without an MCP client sees
 *    a real check land on the Agents page.
 * Demo only: refused with live rails or real money, and unless sandbox mode or the demo personas are on.
 */

export type TourActionResult = { ok: boolean; message: string };

/** The cancel window the tour sets: shortened so it runs out during the tour. Settings keeps its own minimum of a minute. */
const SANDBOX_WINDOW_SECONDS = 20;
const SHARED_WINDOW_SECONDS = 60;
const ROSA_REF = "JOB-CEB2D-1024";
const ROSA_FILE = "tripsheet-ceb2d-1024.pdf";
const DEMO_AGENT = { name: "demo-agent (tour)", scopes: ["check" as const], digest: Buffer.alloc(32) };

const tourAllowed = tourEnabled;

/** The signed-in person (or demo persona) and their real login, as the app's other actions find them. */
async function who(): Promise<{ actor: Actor; login: string; businessId: string }> {
  const h = await headers();
  if (h.get("x-checkrail-public") === "1") throw new Error("Not signed in");
  const username = h.get(ACTOR_HEADER);
  const role = h.get(ROLE_HEADER);
  if (!username || !isRole(role)) throw new Error("Not signed in");
  const biz = getDb().select({ id: businesses.id }).from(businesses).get();
  if (!biz) throw new Error("No business configured. Start over to load the demo.");
  const login = h.get(PERSONA_HEADER) ?? username;
  return { actor: runAs(login, () => resolveActor(getDb(), biz.id, username, role, h.get(PERSONA_HEADER) ?? undefined)), login, businessId: biz.id };
}

function may(actor: Actor, p: Permission, what: string): void {
  requirePermission(actor, p, what);
}

export async function tourAutopilotAction(): Promise<TourActionResult> {
  try {
    if (!tourAllowed()) return { ok: false, message: "The tour's shortcuts work on the demo only." };
    const { actor, login, businessId } = await who();
    may(actor, "settings", "change autonomy and caps");
    may(actor, "ingest", "create payment requests");
    return await runAs(login, async () => {
      const db = getDb();
      // Rosa's trip sheet, as New request brings it in: the PDF is read, its figures become the evidence.
      const open = db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.businessId, businessId), eq(obligations.sourceRef, ROSA_REF), notInArray(obligations.state, ["blocked", "cancelled"]))).get();
      if (!open) {
        const bytes = fs.readFileSync(path.join(process.cwd(), "public", "demo-documents", ROSA_FILE));
        const up = await uploadDocument(db, { businessId, name: ROSA_FILE, mimeType: "application/pdf", bytes, actor: actor.id });
        await ingestObligation(db, { businessId, sourceType: "invoice", rawInput: "Trip sheet attached for Rosa, please pay.", evidence: up.proposed.map((p) => ({ ...p, attachmentId: up.attachmentId })), actor: actor.id, evidenceSource: "operator" });
      }
      const seconds = sandboxActive() ? SANDBOX_WINDOW_SECONDS : SHARED_WINDOW_SECONDS;
      setAutonomy(db, businessId, actor.id, { autonomy: "autopilot", autopilotCancelWindowSeconds: seconds });
      const pass = await runAutopilot(db, { businessId });
      for (const p of ["/", "/obligations", "/settings", "/close", "/demo"]) revalidatePath(p);
      const window = seconds === SANDBOX_WINDOW_SECONDS ? `${seconds} seconds (shortened for this demo; the default is 10 minutes)` : "1 minute (the shortest Settings allows)";
      return {
        ok: true,
        message:
          pass.scheduled.length === 1 ? `Autopilot is on. Rosa's USD 190 is scheduled with a cancel window of ${window}.`
          : pass.scheduled.length > 1 ? `Autopilot is on. ${pass.scheduled.length} payments the rules passed are scheduled, each with a cancel window of ${window}.`
          : `Autopilot is on with a cancel window of ${window}. Nothing new was ready to schedule.`,
      };
    });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function tourDemoAgentAction(): Promise<TourActionResult> {
  try {
    if (!tourAllowed()) return { ok: false, message: "The tour's shortcuts work on the demo only." };
    await who();
    // Exactly what an agent's tools/call does over /api/mcp, as a demo agent with the check scope only.
    const reply = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914", description: "Guide fee for JOB-HG4D-0914, 4 days. Payment to PayPal please." } } },
      { db: getDb(), agent: DEMO_AGENT, version: (pkg as { version: string }).version },
    );
    revalidatePath("/agents");
    const result = reply && "result" in reply ? (reply.result as { structuredContent?: { verdict?: string; summary?: string } }) : null;
    const answer = result?.structuredContent;
    if (!answer?.verdict) return { ok: false, message: "The check did not complete. Nothing was paid." };
    const word = answer.verdict === "block" ? "Blocked" : answer.verdict === "pay" ? "Clear" : "A person looks";
    return { ok: true, message: `${word}. ${answer.summary ?? ""}`.trim() };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
