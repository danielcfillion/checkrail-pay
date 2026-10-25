import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { bankBatchLines, bankBatches, obligations, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";
import { decryptField, lastFour } from "../crypto/dataKey";
import { csvCell } from "../accounting/record";
import { localDateString } from "../format";
import { actorCan, requirePermission, type Actor } from "./users";
import { confirmSettlement } from "./orchestrator";

/**
 * The life of a bank bulk-payment file: open (payments join it), downloaded (frozen; new payments start a new
 * file), confirmed (the bank shows it paid; every line settles). A line the bank returns fails its payment, which
 * can then be retried or cancelled like any failed payment.
 */

export function listBatches(db: Db, businessId: string) {
  const batches = db.select().from(bankBatches).where(eq(bankBatches.businessId, businessId)).orderBy(desc(bankBatches.createdAt)).all();
  return batches.map((b) => {
    const lines = db
      .select({ id: bankBatchLines.id, obligationId: bankBatchLines.obligationId, amountMinor: bankBatchLines.amountMinor, currency: bankBatchLines.currency, beneficiaryName: bankBatchLines.beneficiaryName, bankCode: bankBatchLines.bankCode, accountEnc: bankBatchLines.accountEnc, memo: bankBatchLines.memo, status: bankBatchLines.status, vendorName: vendors.name })
      .from(bankBatchLines)
      .leftJoin(obligations, eq(obligations.id, bankBatchLines.obligationId))
      .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
      .where(eq(bankBatchLines.batchId, b.id))
      .all()
      .map(({ accountEnc, ...l }) => ({ ...l, accountMasked: safeLastFour(accountEnc) }));
    return { ...b, lines, totalMinor: lines.reduce((a, l) => a + l.amountMinor, 0) };
  });
}

function safeLastFour(enc: string): string {
  try {
    return lastFour(decryptField(enc));
  } catch {
    return "****";
  }
}

/** Vietnamese bank content fields take plain ASCII; strip accents rather than let the bank reject the line. */
export function bankText(s: string, max: number): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9 .,/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The file, as CSV in the column order Vietnamese corporate banking bulk uploads use (STT, account number, name,
 * bank code, amount, content). Most banks offer their own template: map these columns onto it if it differs.
 * Downloading freezes the file: payments after this go into a new one, so the uploaded file and the record match.
 */
export function downloadBatch(db: Db, businessId: string, by: Actor, batchId: string): { filename: string; csv: string } {
  requirePermission(by, "pay", "download bank payment files");
  const b = db.select().from(bankBatches).where(and(eq(bankBatches.id, batchId), eq(bankBatches.businessId, businessId))).get();
  if (!b) throw new Error("No such bank file");
  if (b.status === "open") db.update(bankBatches).set({ status: "downloaded", downloadedAt: now(), downloadedBy: by.id }).where(and(eq(bankBatches.id, batchId), eq(bankBatches.status, "open"))).run();
  const lines = db.select().from(bankBatchLines).where(eq(bankBatchLines.batchId, batchId)).all().filter((l) => l.status === "queued");
  const rows = [["STT", "So tai khoan", "Ten nguoi huong", "Ma ngan hang", "So tien", "Noi dung"].join(",")];
  lines.forEach((l, i) => {
    rows.push([i + 1, decryptField(l.accountEnc), bankText(l.beneficiaryName, 70).toUpperCase(), l.bankCode, Math.round(l.amountMinor / 100), bankText(l.memo, 160)].map(csvCell).join(","));
  });
  audit(db, { obligationId: null, actor: by.id, action: "bank_file.downloaded", detail: { batchId, lines: lines.length, again: b.status !== "open" } });
  return { filename: `bank-file-${b.currency}-${localDateString(new Date(b.createdAt))}-${b.id.slice(-6)}.csv`, csv: rows.join("\r\n") + "\r\n" };
}

/** The bank shows the file paid: settle every line still queued. */
export async function confirmBatch(db: Db, businessId: string, by: Actor, batchId: string): Promise<number> {
  if (!actorCan(by, "reconcile")) requirePermission(by, "pay", "confirm bank payment files");
  const b = db.select().from(bankBatches).where(and(eq(bankBatches.id, batchId), eq(bankBatches.businessId, businessId))).get();
  if (!b) throw new Error("No such bank file");
  if (b.status !== "downloaded") throw new Error(b.status === "open" ? "Download the file and upload it to the bank first" : "This file is already confirmed");
  const won = db.update(bankBatches).set({ status: "confirmed", confirmedAt: now(), confirmedBy: by.id }).where(and(eq(bankBatches.id, batchId), eq(bankBatches.status, "downloaded"))).run();
  if (won.changes !== 1) throw new Error("Someone else confirmed this file just now");
  const queued = db.select().from(bankBatchLines).where(and(eq(bankBatchLines.batchId, batchId), eq(bankBatchLines.status, "queued"))).all();
  if (queued.length) db.update(bankBatchLines).set({ status: "paid" }).where(inArray(bankBatchLines.id, queued.map((l) => l.id))).run();
  audit(db, { obligationId: null, actor: by.id, action: "bank_file.confirmed", detail: { batchId, lines: queued.length } });
  for (const l of queued) await confirmSettlement(db, l.obligationId, "bank_file");
  return queued.length;
}

/** The bank returned one line (wrong account, closed account): that payment fails and can be retried or cancelled. */
export async function returnLine(db: Db, businessId: string, by: Actor, lineId: string, reason: string): Promise<void> {
  if (!actorCan(by, "reconcile")) requirePermission(by, "pay", "record a bank return");
  const line = db.select().from(bankBatchLines).where(eq(bankBatchLines.id, lineId)).get();
  const b = line ? db.select().from(bankBatches).where(and(eq(bankBatches.id, line.batchId), eq(bankBatches.businessId, businessId))).get() : null;
  if (!line || !b) throw new Error("No such line");
  if (b.status === "open") throw new Error("This file has not gone to the bank yet");
  if (line.status === "returned") return;
  if (line.status === "paid") throw new Error("This line was confirmed paid; a later return is a refund from the vendor, recorded on the payment");
  db.update(bankBatchLines).set({ status: "returned" }).where(eq(bankBatchLines.id, lineId)).run();
  audit(db, { obligationId: line.obligationId, actor: by.id, action: "bank_file.line_returned", detail: { lineId, reason: reason.slice(0, 200) } });
  await confirmSettlement(db, line.obligationId, "bank_file");
}
