import Link from "next/link";
import { TOUCH_INLINE } from "@/components/RequestPanels";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { AGE_BUCKETS, agedPayables, listReconciliations } from "@/lib/engine/books";
import { formatDate, formatDateTime, formatMoney, formatMoneySymbol, localDateString } from "@/lib/format";
import { form1099Report } from "@/lib/engine/taxes";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { PeriodLock, ReconcileFromPayPal, ReconcileUpload } from "@/components/BooksControls";
import { isLiveRails } from "@/lib/config";
import { taxFeaturesOn } from "@/lib/features";

export const dynamic = "force-dynamic";
export const metadata = { title: "Books" };

export default async function BooksPage() {
  const biz = getBusiness();
  if (!biz) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;
  const viewer = await getViewer();
  const db = getDb();
  const aged = agedPayables(db, biz.id);
  const recs = listReconciliations(db, biz.id);
  const last = recs[0] ?? null;
  const canRecon = !viewer || viewer.can("reconcile") || viewer.can("pay");
  const total = Object.values(aged.totals).reduce((a, b) => a + b, 0);
  const year = Number(localDateString().slice(0, 4));
  const showTax = taxFeaturesOn();
  const forms = showTax ? form1099Report(db, biz.id, year) : [];
  return (
    <>
      <PageHeader title="Books" lede="What is owed and how late, whether PayPal's statement agrees with what was paid, and which periods are closed." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Aged payables" aside={`${formatMoneySymbol(total, aged.baseCurrency)} owed`} className="lg:col-span-2" padded={false}>
          <dl className="grid grid-cols-2 gap-y-3 border-b px-4 py-3 hairline sm:grid-cols-5">
            {AGE_BUCKETS.map((b, i) => (
              <div key={b}>
                <dt className="dense text-ink-soft">{b}</dt>
                <dd className={`num text-lg ${i >= 2 && aged.totals[b] > 0 ? "text-attention" : ""}`}>{formatMoneySymbol(aged.totals[b], aged.baseCurrency)}</dd>
              </div>
            ))}
          </dl>
          {aged.rows.length ? (
            <div className="overflow-x-auto">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Vendor</th>
                    <th scope="col" className="max-sm:hidden">Reference</th>
                    <th scope="col" className="hidden sm:table-cell">Due</th>
                    <th scope="col">Age</th>
                    <th scope="col" className="hidden md:table-cell">Status</th>
                    <th scope="col" className="r">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {aged.rows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <td className="font-medium">
                        <Link href={r.kind === "bill" ? `/vendors/${r.vendorId}` : `/obligations/${r.id}`} className={`hover:underline ${TOUCH_INLINE}`}>
                          {r.vendorName}
                        </Link>
                        {/* On a phone the reference rides under the name, so the amount keeps its column. */}
                        <span className="num block text-xs font-normal text-ink-soft sm:hidden">{r.reference}</span>
                      </td>
                      <td className="num whitespace-nowrap text-ink-soft max-sm:hidden">{r.reference}</td>
                      <td className="num hidden whitespace-nowrap text-ink-soft sm:table-cell">{r.dueDate ? formatDate(r.dueDate) : ""}</td>
                      <td className={`whitespace-nowrap ${r.daysOverdue > 30 ? "text-attention" : "text-ink-soft"}`}>{r.daysOverdue > 0 ? `${r.daysOverdue} day${r.daysOverdue === 1 ? "" : "s"} late` : "not yet due"}</td>
                      <td className="hidden text-ink-soft md:table-cell">{r.detail}</td>
                      <td className="r num whitespace-nowrap">{formatMoney(r.amountMinor, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-3 text-ink-soft">Nothing owed.</p>
          )}
        </Panel>

        <Panel title="PayPal statement" aside={last ? `last ${formatDateTime(last.createdAt)}` : "not reconciled yet"}>
          <p className="mb-3 text-ink-soft">Read the statement straight from PayPal, or upload the activity CSV (Activity, Statements, Activity download). Each payout is matched to a payment by recipient, amount and date; money that came back is tied to its payout by the transaction it reverses.</p>
          {canRecon ? (
            <div className="space-y-3">
              <ReconcileFromPayPal live={isLiveRails()} defaultFrom={localDateString(new Date(Date.now() - 30 * 86_400_000))} defaultTo={localDateString()} />
              <ReconcileUpload primary={!isLiveRails()} />
            </div>
          ) : null}
          {last ? (
            <div className="mt-4 space-y-3 border-t pt-3 text-sm hairline">
              <p>
                {last.result.periodFrom} to {last.result.periodTo}: <span className="text-settled">{last.result.matched.length} matched</span>,{" "}
                <span className={last.result.statementOnly.length ? "text-attention" : ""}>{last.result.statementOnly.length} on the statement only</span>, {last.result.appOnly.length} recorded here only.
              </p>
              {last.result.recorded === false ? (
                <p className="rounded-md border border-attention/40 bg-attention/10 p-2 text-attention">
                  Shown to you, not saved. Only someone who reconciles (the accountant, an approver or the owner) saves matches against a statement.
                </p>
              ) : null}
              {last.result.statementOnly.length ? (
                <div>
                  <p className="font-medium text-attention">Money left PayPal with no payment here. Look at these first:</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.statementOnly.map((l) => (
                      <li key={l.transactionId} className="num text-xs">
                        {formatDate(l.date)} {formatMoney(l.amountMinor, l.currency)} to {l.name || l.toEmail} ({l.transactionId})
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {last.result.returned?.length ? (
                <div>
                  <p className="font-medium text-attention">Came back to PayPal: these vendors are owed again.</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.returned.map((l) => (
                      <li key={l.transactionId} className="num text-xs">
                        <Link href={`/obligations/${l.obligationId}`} className="link">
                          {l.vendorName}
                        </Link>{" "}
                        {formatMoney(l.amountMinor, l.currency)} on {formatDate(l.date)} ({l.type || "returned"}).{" "}
                        {l.applied === false ? "Not applied: someone who reconciles (the accountant, an approver or the owner) uploads this statement to mark it." : "Marked refunded; check their details, then pay it again (from the payment page, or the vendor\u2019s page when it was part of a bill)."}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {last.result.returnedUnmatched?.length ? (
                <div>
                  <p className="font-medium text-attention">Money came back but could not be tied to one of our payouts. Look these up in PayPal:</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.returnedUnmatched.map((l) => (
                      <li key={l.transactionId} className="num text-xs">
                        {formatDate(l.date)} {formatMoney(l.amountMinor, l.currency)} from {l.name || "unknown"} ({l.transactionId}{l.referenceTxnId ? `, reverses ${l.referenceTxnId}` : ""}): {l.why}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {last.result.feeDiffs?.length ? (
                <div>
                  <p className="font-medium">Fee on the statement differs from the fee recorded here:</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.feeDiffs.map((l) => (
                      <li key={l.obligationId} className="num text-xs">
                        <Link href={`/obligations/${l.obligationId}`} className="link">
                          {l.vendorName}
                        </Link>{" "}
                        statement {formatMoney(l.statementFeeMinor, l.currency)}, recorded {formatMoney(l.recordedFeeMinor, l.currency)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {last.result.appOnly.length ? (
                <div>
                  <p className="font-medium">Paid here, not on the statement (still in transit, or paid another way):</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.appOnly.map((l) => (
                      <li key={l.settlementId} className="num text-xs">
                        <Link href={`/obligations/${l.obligationId}`} className="link">
                          {l.vendorName}
                        </Link>{" "}
                        {formatMoney(l.amountMinor, l.currency)} on {formatDate(l.settledAt)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>

        {showTax ? (
        <Panel title={`US 1099-NEC, ${year}`} aside="USD 2,000 threshold" className="lg:col-span-2" padded={forms.length === 0}>
          {forms.length ? (
            <div className="overflow-x-auto">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Payee</th>
                    <th scope="col">W-9</th>
                    <th scope="col" className="r">Paid this year</th>
                    <th scope="col" className="r">Withheld</th>
                    <th scope="col">1099-NEC</th>
                  </tr>
                </thead>
                <tbody>
                  {forms.map((f) => (
                    <tr key={f.vendorId}>
                      <td className="font-medium">
                        <Link href={`/vendors/${f.vendorId}`} className="hover:underline">
                          {f.name}
                        </Link>
                      </td>
                      <td className={f.taxForm === "w9" ? "text-settled" : "text-attention"}>{f.taxForm === "w9" ? "on file" : "missing"}</td>
                      <td className="r num">{formatMoney(f.paidMinor, "USD")}</td>
                      <td className="r num">{formatMoney(f.withheldMinor, "USD")}</td>
                      <td>{f.needs1099 ? "file one" : "not needed yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-ink-soft">No US payees paid this year.</p>
          )}
        </Panel>
        ) : null}

        <Panel title="Closed periods" aside={biz.lockedThrough ? `closed through ${formatDate(biz.lockedThrough)}` : "all open"}>
          <p className="mb-3 text-ink-soft">Once a month is reported, close it. Nothing dated in a closed period can be amended, credited, voided or cancelled after its bill went to the books. Only the owner reopens.</p>
          <PeriodLock current={biz.lockedThrough ?? null} canLock={!viewer || viewer.can("lock_period")} canReopen={!viewer || viewer.actor.role === "admin"} />
        </Panel>
      </div>
    </>
  );
}
