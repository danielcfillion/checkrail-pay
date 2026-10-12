import { eq, desc } from "drizzle-orm";
import { getDb, closeDb } from "../src/lib/db";
import { obligations, settlements, auditEntries, paymentAttempts } from "../src/lib/db/schema";
import { seedDemo } from "../src/lib/demo/seed";
import { approveObligation, confirmSettlement, executeObligation } from "../src/lib/engine/orchestrator";
import { exportPendingCsv } from "../src/lib/accounting/record";
import { railModes } from "../src/lib/rails";
import { fmt } from "../src/lib/domain/policy";

/**
 * Terminal replay of the three-obligation story. Deterministic in mock mode;
 * hits PayPal sandbox and Stellar testnet in live mode.
 */
async function main() {
  const db = getDb();
  console.log(`Rails: paypal=${railModes().paypal} stellar=${railModes().stellar}\n`);
  const { story } = await seedDemo(db, { history: true });

  /** Live rails settle asynchronously: poll for a short while, then report what the provider says. Never assume settled. */
  async function settleOrReport(id: string, execStatus: string) {
    for (let i = 0; i < 6; i++) {
      await confirmSettlement(db, id);
      if (get(id).state === "settled") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const ob = get(id);
    const sx = db.select().from(settlements).where(eq(settlements.obligationId, id)).get();
    const at = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).orderBy(desc(paymentAttempts.createdAt)).get();
    console.log(`   execute: ${execStatus}; state now: ${ob.state}; rail attempt: ${at?.status ?? "none"} / ${at?.externalStatus ?? "-"} ${at?.externalId ? `(id ${at.externalId})` : ""}${at?.errorMessage ? ` error: ${at.errorMessage}` : ""}`);
    if (sx) {
      const tag = sx.explorerUrl ?? (railModes()[ob.selectedRail as "paypal" | "stellar"] === "mock" ? "(simulated)" : /modelled/i.test(sx.note ?? "") ? "(modelled from the published fee schedule)" : "");
      console.log(`   ${tag} fee ${fmt(sx.feeMinor, sx.grossCurrency)}; recipient gets ${fmt(sx.receivedMinor!, sx.receivedCurrency!)}`);
    }
    else console.log("   Not settled yet. The provider has not confirmed; check the sandbox dashboard and re-run reconcile later.");
  }
  const get = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

  const c = get(story.blockedMismatch);
  console.log(`1. ${c.vendorId} ${c.sourceRef}: ${c.state.toUpperCase()}`);
  console.log(`   ${c.blockedReason}`);

  const c2 = get(story.blockedDuplicate);
  console.log(`2. ${c2.sourceRef}: ${c2.state.toUpperCase()}`);
  console.log(`   ${c2.blockedReason}`);

  const a = get(story.paypal);
  console.log(`3. ${a.sourceRef} ${fmt(a.amountMinor!, a.currency!)}: ${a.state} -> ${a.selectedRail} (${a.routeReason})`);
  if (a.state !== "approved") {
    // With the Claude agent live, a concern it raises holds the payment for a person. Show why, then approve as the operator would.
    const reasons = JSON.parse(a.policyReasonsJson ?? "[]") as string[];
    console.log(`   Held for a person: ${reasons.join("; ") || a.state}`);
    if (a.state === "awaiting_approval") {
      approveObligation(db, a.id, "user:daniel", "Reviewed the agent's concerns");
      console.log(`   Approved by the operator; state now: ${get(a.id).state}`);
    }
  }
  if (get(a.id).state === "approved") {
    const ra = await executeObligation(db, a.id, { actor: "user:daniel" });
    await settleOrReport(a.id, ra.status);
  } else {
    console.log("   Not paid: still needs a person (see the reasons above).");
  }

  const b = get(story.stellar);
  console.log(`4. ${b.sourceRef} ${fmt(b.amountMinor!, b.currency!)}: ${b.state} -> ${b.selectedRail} (${b.routeReason})`);
  if (b.state === "awaiting_approval") approveObligation(db, b.id, "user:daniel", "Rate confirmed with ops");
  if (get(b.id).state === "approved") {
    const rb = await executeObligation(db, b.id, { actor: "user:daniel" });
    await settleOrReport(b.id, rb.status);
  } else {
    console.log(`   Not paid: ${get(b.id).state} (${(JSON.parse(get(b.id).policyReasonsJson ?? "[]") as string[]).join("; ")})`);
  }

  const { count } = exportPendingCsv(db);
  const audits = db.select().from(auditEntries).all().length;
  console.log(`\nResult: ${db.select().from(obligations).all().filter((o) => [story.paypal, story.stellar].includes(o.id) && o.state === "settled").length} of 2 settled, 2 errors prevented, ${count} accounting records exported, ${audits} audit entries.`);
  closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
