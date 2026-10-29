import Link from "next/link";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { listRuns, runCandidates } from "@/lib/engine/runs";
import { formatDate, localDateString } from "@/lib/format";
import { toBaseOrZero } from "@/lib/fx";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { RunBuilder } from "@/components/RunBuilder";
import { RunsGrid } from "@/components/grid/RunsGrid";
import { toPayableRow, toRunRow } from "@/components/grid/model";

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
  // Plain rows for the client grids; amounts are put in the base currency here, where the reference rates live.
  const toBase = (minor: number, currency: string) => toBaseOrZero(minor, currency, biz.baseCurrency ?? "USD");
  const today = localDateString();
  const payable = candidates.map((c) => toPayableRow({ id: c.id, vendorName: c.vendorName, sourceRef: c.sourceRef, amountMinor: c.amountMinor!, currency: c.currency!, dueDate: c.dueDate, state: c.state, rail: c.selectedRail, scheduled: Boolean(c.releaseAt) }, { toBase, today }));
  const runRows = runs.map((r) => toRunRow(r, { toBase }));
  return (
    <>
      <PageHeader
        title="Payment runs"
        lede="Gather what is due into one list. An approver checks the total against what is in the account and releases it once. Each payment still gets every check it would get on its own."
        actions={
          <Link href="/bank-files" className="btn">
            Bank files
          </Link>
        }
      />
      {canBuild ? (
        <Panel title="New run" aside={`${candidates.length} payable`} className="mb-6" padded={candidates.length === 0}>
          {candidates.length ? (
            <div className="p-4">
              <RunBuilder defaultName={`Week of ${formatDate(today)}`} rows={payable} />
            </div>
          ) : (
            <p className="text-ink-soft">Nothing is approved or waiting for approval outside a run right now.</p>
          )}
        </Panel>
      ) : null}
      <Panel title="Runs" padded={runs.length === 0}>
        {runs.length ? (
          <RunsGrid rows={runRows} />
        ) : (
          <p className="text-ink-soft">No runs yet.</p>
        )}
      </Panel>
    </>
  );
}
