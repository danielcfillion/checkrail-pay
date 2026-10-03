import { eq } from "drizzle-orm";
import { getDb, closeDb } from "../src/lib/db";
import { obligations, settlements, auditEntries } from "../src/lib/db/schema";
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
  const get = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

  const c = get(story.blockedMismatch);
  console.log(`1. ${c.vendorId} ${c.sourceRef}: ${c.state.toUpperCase()}`);
  console.log(`   ${c.blockedReason}`);

  const c2 = get(story.blockedDuplicate);
  console.log(`2. ${c2.sourceRef}: ${c2.state.toUpperCase()}`);
  console.log(`   ${c2.blockedReason}`);

  const a = get(story.paypal);
  console.log(`3. ${a.sourceRef} ${fmt(a.amountMinor!, a.currency!)}: ${a.state} -> ${a.selectedRail} (${a.routeReason})`);
  const ra = await executeObligation(db, a.id, { actor: "user:daniel" });
  await confirmSettlement(db, a.id);
  const sa = db.select().from(settlements).where(eq(settlements.obligationId, a.id)).get()!;
  console.log(`   ${ra.status} -> ${get(a.id).state}; batch ${sa.externalId}; fee ${fmt(sa.feeMinor, sa.grossCurrency)}; recipient gets ${fmt(sa.receivedMinor!, sa.receivedCurrency!)}`);

  const b = get(story.stellar);
  console.log(`4. ${b.sourceRef} ${fmt(b.amountMinor!, b.currency!)}: ${b.state} -> ${b.selectedRail} (${b.routeReason})`);
  approveObligation(db, b.id, "user:daniel", "Rate confirmed with ops");
  const rb = await executeObligation(db, b.id, { actor: "user:daniel" });
  const sb = db.select().from(settlements).where(eq(settlements.obligationId, b.id)).get()!;
  console.log(`   approved -> ${rb.status} -> ${get(b.id).state}; tx ${sb.externalId}`);
  console.log(`   ${sb.explorerUrl}; fee ${fmt(sb.feeMinor, sb.grossCurrency)}; recipient gets ${fmt(sb.receivedMinor!, sb.receivedCurrency!)}`);

  const { count } = exportPendingCsv(db);
  const audits = db.select().from(auditEntries).all().length;
  console.log(`\nResult: 2 settled, 2 errors prevented, ${count} accounting records exported, ${audits} audit entries.`);
  closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
