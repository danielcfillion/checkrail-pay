import { runAs } from "@/lib/engine/requestContext";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { viewRun } from "@/lib/engine/runs";
import { formatDate, formatMoney, humaniseActor, railLabel, stateLabel } from "@/lib/format";
import { PageHeader, Panel, RailTag } from "@/components/ui";
import { CancelRun, ReleaseRun, RemoveItem } from "@/components/RunActions";
import { RunRemittances } from "@/components/RunRemittances";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment run" };

const ITEM_TONE: Record<string, string> = { paid: "text-settled", with_bank: "text-attention", failed: "text-attention", unclear: "text-attention", skipped: "text-ink-soft", queued: "" };
const ITEM_LABEL: Record<string, string> = { paid: "paid", with_bank: "queued for the bank", failed: "failed", unclear: "unclear", skipped: "skipped", queued: "queued" };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const biz = getBusiness();
  if (!biz) notFound();
  const viewer = await getViewer();
  let v;
  try {
    v = await runAs(viewer?.login ?? null, () => viewRun(getDb(), biz.id, id, viewer?.actor ?? null));
  } catch {
    notFound();
  }
  const { run, items, totals, releaseRefusal } = v;
  const draft = run.status === "draft";
  const resumable = run.status === "releasing" && viewer && run.releasedBy === viewer.actor.id;
  const short = totals.some((t) => t.short);
  const waiting = items.filter((i) => i.state === "awaiting_approval").length;
  const blockedForMe = items.filter((i) => i.approvalNote).length;
  const canBuild = !viewer || viewer.can("build_run");
  const byCurrency = new Map<string, number>();
  for (const t of totals) byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + t.totalMinor + t.feeMinor);
  const grand = [...byCurrency.entries()].map(([c, m]) => formatMoney(m, c));

  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/runs" className="hover:text-ink">
          Payment runs
        </Link>
        <span aria-hidden> / </span>
        {run.name}
      </nav>
      <PageHeader
        title={run.name}
        lede={
          draft
            ? `Built by ${humaniseActor(run.createdBy)} on ${formatDate(run.createdAt)}. ${items.length} payment${items.length === 1 ? "" : "s"}${waiting ? `, ${waiting} still waiting for approval` : ""}.`
            : run.status === "released"
              ? `Released by ${humaniseActor(run.releasedBy)} on ${formatDate(run.releasedAt)}.`
              : run.status === "releasing"
                ? `Release started by ${humaniseActor(run.releasedBy)} and did not finish. Items still queued were not paid.`
                : "Cancelled. Nothing in it was paid."
        }
        actions={
          draft ? (
            <div className="flex flex-wrap gap-2">
              {releaseRefusal ? null : (
                <ReleaseRun
                  runId={run.id}
                  disabled={short}
                  label={`Release ${grand.join(" + ")}`}
                  confirmText={`Pay ${items.length - blockedForMe} payment${items.length - blockedForMe === 1 ? "" : "s"} now${waiting ? `, approving ${waiting - blockedForMe} that are waiting` : ""}. Each one is checked again just before it goes; anything that changed is skipped, not paid.`}
                />
              )}
              {canBuild || !releaseRefusal ? <CancelRun runId={run.id} /> : null}
            </div>
          ) : resumable ? (
            <ReleaseRun runId={run.id} label="Finish releasing" confirmText="Pay the items still queued. Items already paid, skipped or failed are left as they are." />
          ) : undefined
        }
      />
      {draft && releaseRefusal ? <p className="mb-4 rounded border px-3 py-2 text-ink-soft hairline">{releaseRefusal}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Panel title="Payments" padded={false}>
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col" className="hidden sm:table-cell">Reference</th>
                  <th scope="col">{draft ? "Now" : "Result"}</th>
                  <th scope="col" className="hidden sm:table-cell">Rail</th>
                  <th scope="col" className="r">Amount</th>
                  {draft && canBuild ? (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="font-medium">
                      <Link href={`/obligations/${i.obligationId}`} className="hover:underline">
                        {i.vendorName ?? "Unknown vendor"}
                      </Link>
                    </td>
                    <td className="num hidden whitespace-nowrap text-ink-soft sm:table-cell">{i.sourceRef ?? "none"}</td>
                    <td className={draft ? (i.changed || i.approvalNote ? "text-attention" : "text-ink-soft") : ITEM_TONE[i.status]}>
                      {draft ? (i.changed ? "amount changed since added; will be skipped" : i.approvalNote ? i.approvalNote : stateLabel(i.state ?? "")) : ITEM_LABEL[i.status] ?? i.status}
                      {!draft && i.message ? <span className="block text-xs text-ink-soft">{i.message}</span> : null}
                    </td>
                    <td className="hidden sm:table-cell">{i.rail ? <RailTag rail={i.rail} /> : <span className="text-ink-soft">none</span>}</td>
                    <td className="r num whitespace-nowrap">{formatMoney(i.amountMinor, i.currency)}</td>
                    {draft && canBuild ? (
                      <td className="r">
                        <RemoveItem runId={run.id} itemId={i.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="space-y-6">
          {run.status === "released" && (!viewer || viewer.can("pay")) ? (
            <Panel title="Tell the vendors" aside="in their language">
              <RunRemittances runId={run.id} />
            </Panel>
          ) : null}
          <Panel title={draft ? "Funding" : "Sent by rail"}>
            {totals.length ? (
              <ul className="space-y-3">
                {totals.map((t) => (
                  <li key={`${t.rail}-${t.currency}`}>
                    <p className="flex items-baseline justify-between gap-2">
                      <span>{railLabel(t.rail) || t.rail}</span>
                      <span className="num">{formatMoney(t.totalMinor + t.feeMinor, t.currency)}</span>
                    </p>
                    {t.feeMinor ? <p className="num text-xs text-ink-soft">{formatMoney(t.totalMinor, t.currency)} to payees + {formatMoney(t.feeMinor, t.currency)} fees</p> : null}
                    {draft ? (
                      <p className={`text-xs ${t.short ? "text-attention" : "text-ink-soft"}`}>
                        {t.balance
                          ? `${t.short ? "Short: " : ""}${formatMoney(t.balance.availableMinor, t.currency)} available${t.balance.source === "simulated" ? " (simulated balance)" : ""}`
                          : "Balance not available from this provider; check it before releasing"}
                      </p>
                    ) : (
                      <p className="text-xs text-ink-soft">{t.count} payment{t.count === 1 ? "" : "s"}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-soft">{draft ? "Nothing payable in this run." : "Nothing was paid."}</p>
            )}
            {draft && short ? <p className="mt-3 border-t pt-2 text-xs text-attention hairline">Release is off until the account is topped up or payments are removed. A payout that bounces for low funds costs a day.</p> : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
