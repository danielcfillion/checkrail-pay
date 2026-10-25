import Link from "next/link";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { AGE_BUCKETS, agedPayables, listReconciliations } from "@/lib/engine/books";
import { formatDateTime, formatMoney, formatMoneySymbol } from "@/lib/format";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { PeriodLock, ReconcileUpload } from "@/components/BooksControls";

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
                    <th scope="col">Reference</th>
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
                        <Link href={r.kind === "bill" ? `/vendors/${r.vendorId}` : `/obligations/${r.id}`} className="hover:underline">
                          {r.vendorName}
                        </Link>
                      </td>
                      <td className="num text-ink-soft">{r.reference}</td>
                      <td className="num hidden text-ink-soft sm:table-cell">{r.dueDate}</td>
                      <td className={r.daysOverdue > 30 ? "text-attention" : "text-ink-soft"}>{r.daysOverdue > 0 ? `${r.daysOverdue} days late` : "not yet due"}</td>
                      <td className="hidden text-ink-soft md:table-cell">{r.kind === "bill" ? "bill, part paid or unpaid" : r.state.replace(/_/g, " ")}</td>
                      <td className="r num">{formatMoney(r.amountMinor, r.currency)}</td>
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
          <p className="mb-3 text-ink-soft">Download the activity CSV from PayPal (Activity, Statements, Activity download) and upload it here. Each payout line is matched to a payment by recipient, amount and date.</p>
          {canRecon ? <ReconcileUpload /> : null}
          {last ? (
            <div className="mt-4 space-y-3 border-t pt-3 text-sm hairline">
              <p>
                {last.result.periodFrom} to {last.result.periodTo}: <span className="text-settled">{last.result.matched.length} matched</span>,{" "}
                <span className={last.result.statementOnly.length ? "text-attention" : ""}>{last.result.statementOnly.length} on the statement only</span>, {last.result.appOnly.length} recorded here only.
              </p>
              {last.result.statementOnly.length ? (
                <div>
                  <p className="font-medium text-attention">Money left PayPal with no payment here. Look at these first:</p>
                  <ul className="mt-1 space-y-0.5">
                    {last.result.statementOnly.map((l) => (
                      <li key={l.transactionId} className="num text-xs">
                        {l.date} {formatMoney(l.amountMinor, l.currency)} to {l.name || l.toEmail} ({l.transactionId})
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
                        {formatMoney(l.amountMinor, l.currency)} on {l.settledAt.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>

        <Panel title="Closed periods" aside={biz.lockedThrough ? `closed through ${biz.lockedThrough}` : "all open"}>
          <p className="mb-3 text-ink-soft">Once a month is reported, close it. Nothing dated in a closed period can be amended, credited, voided or cancelled after its bill went to the books. Only the owner reopens.</p>
          <PeriodLock current={biz.lockedThrough ?? null} canLock={!viewer || viewer.can("lock_period")} canReopen={!viewer || viewer.actor.role === "admin"} />
        </Panel>
      </div>
    </>
  );
}
