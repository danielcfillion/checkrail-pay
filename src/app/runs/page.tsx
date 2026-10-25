import Link from "next/link";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { listRuns, runCandidates } from "@/lib/engine/runs";
import { formatDateTime, formatMoney, localDateString } from "@/lib/format";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { RunBuilder } from "@/components/RunBuilder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment runs" };

export default async function RunsPage() {
  const biz = getBusiness();
  const viewer = await getViewer();
  if (!biz) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;
  const db = getDb();
  const runs = listRuns(db, biz.id);
  const candidates = runCandidates(db, biz.id);
  const canBuild = !viewer || viewer.can("build_run");
  return (
    <>
      <PageHeader title="Payment runs" lede="Gather what is due into one list. An approver checks the total against what is in the account and releases it once. Each payment still gets every check it would get on its own." />
      {canBuild ? (
        <Panel title="New run" aside={`${candidates.length} payable`} className="mb-6" padded={candidates.length === 0}>
          {candidates.length ? (
            <div className="p-4">
              <RunBuilder
                defaultName={`Week of ${localDateString()}`}
                rows={candidates.map((c) => ({ id: c.id, vendorName: c.vendorName, sourceRef: c.sourceRef, amountMinor: c.amountMinor!, currency: c.currency!, dueDate: c.dueDate, state: c.state, rail: c.selectedRail, scheduled: Boolean(c.releaseAt) }))}
              />
            </div>
          ) : (
            <p className="text-ink-soft">Nothing is approved or waiting for approval outside a run right now.</p>
          )}
        </Panel>
      ) : null}
      <Panel title="Runs" padded={runs.length === 0}>
        {runs.length ? (
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hidden sm:table-cell">Built by</th>
                  <th scope="col" className="hidden md:table-cell">Created</th>
                  <th scope="col" className="r">Payments</th>
                  <th scope="col" className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="row-link relative">
                    <td className="font-medium">
                      <Link href={`/runs/${r.id}`} className="after:absolute after:inset-0 after:content-['']">
                        {r.name}
                      </Link>
                    </td>
                    <td className={r.status === "draft" ? "text-attention" : "text-ink-soft"}>{r.status === "draft" ? "waiting for release" : r.status}</td>
                    <td className="hidden text-ink-soft sm:table-cell">{r.createdBy.replace(/^user:/, "")}</td>
                    <td className="num hidden text-ink-soft md:table-cell">{formatDateTime(r.createdAt)}</td>
                    <td className="r num">{r.status === "released" ? `${r.paid} of ${r.count} paid` : r.count}</td>
                    <td className="r num">{r.totals.map((t) => formatMoney(t.minor, t.currency)).join(" + ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-ink-soft">No runs yet.</p>
        )}
      </Panel>
    </>
  );
}
