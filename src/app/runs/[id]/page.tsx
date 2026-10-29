import { runAs } from "@/lib/engine/requestContext";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getBusiness, getObligationDetail } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { viewRun } from "@/lib/engine/runs";
import { formatDate, formatMoney, humaniseActor, pluralise, railLabel, stateLabel } from "@/lib/format";
import { PageHeader, Panel, RailTag } from "@/components/ui";
import { ApproveItem, CancelRun, ReleaseRun, RemoveItem } from "@/components/RunActions";
import { RunRemittances } from "@/components/RunRemittances";
import { runLineStatement } from "@/components/check-statement";
import { readingFor } from "@/components/reader-view";

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
  const { run, items, totals, payNow, releaseRefusal } = v;
  const draft = run.status === "draft";
  const resumable = run.status === "releasing" && viewer && run.releasedBy === viewer.actor.id;
  const short = totals.some((t) => t.short);
  const waiting = items.filter((i) => i.state === "awaiting_approval").length;
  const canApproveHere = items.some((i) => i.canApprove);
  // The reader's concern or low confidence, as the request page states it. A release does not read this: it is here so the
  // person is not asked to release what the request page would have warned them about.
  const db = getDb();
  const reading = new Map(
    draft
      ? items.flatMap((i) => {
          const d = getObligationDetail(i.obligationId, db);
          const line = d ? runLineStatement({ rules: d.policyRules, reader: readingFor(d, db).reader }) : null;
          return line ? [[i.obligationId, line] as const] : [];
        })
      : [],
  );
  const readerOnPay = items.filter((i) => i.plan === "pay" && reading.has(i.obligationId)).length;
  // What a release would actually do, in words: what is paid, and what is left for its own page and why.
  const leftWhy = [
    payNow.leftByReason.warning ? `${payNow.leftByReason.warning} carry${payNow.leftByReason.warning === 1 ? "es" : ""} a warning or only the vendor's own support, which a person reads first` : null,
    payNow.leftByReason.limit ? `${payNow.leftByReason.limit} ${payNow.leftByReason.limit === 1 ? "is" : "are"} above your approval limit or yours to approve` : null,
    payNow.leftByReason.second ? `${payNow.leftByReason.second} need${payNow.leftByReason.second === 1 ? "s" : ""} a second approver` : null,
    payNow.leftByReason.changed ? `${payNow.leftByReason.changed} changed amount since being added` : null,
    payNow.leftByReason.state ? `${payNow.leftByReason.state} ${payNow.leftByReason.state === 1 ? "is" : "are"} no longer payable` : null,
  ].filter(Boolean);
  const confirmText = `${payNow.count ? `Pay ${pluralise(payNow.count, "payment")} now${payNow.approving ? `, approving ${payNow.approving} that ${payNow.approving === 1 ? "is" : "are"} waiting` : ""}.` : "Nothing in this run can be paid now."}${payNow.left ? ` ${payNow.left} will be left for ${payNow.left === 1 ? "its" : "their"} own ${payNow.left === 1 ? "page" : "pages"} and not paid: ${leftWhy.join("; ")}.${canApproveHere ? " Approve them here first to include them." : ""}` : ""}${readerOnPay ? ` ${readerOnPay} of the payments going out ${readerOnPay === 1 ? "carries" : "carry"} a reader concern or low confidence that a release does not stop for; read ${readerOnPay === 1 ? "it" : "them"} on the lines first.` : ""} Each payment is checked again just before it goes; anything that changed is skipped, not paid.`;
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
                  label={`Release ${payNow.count ? payNow.byCurrency.map((c) => formatMoney(c.minor, c.currency)).join(" + ") : grand.join(" + ")}`}
                  confirmText={confirmText}
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
                  {draft && (canBuild || canApproveHere) ? (
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
                    <td className={draft ? (i.changed || i.approvalNote || i.warnings.length ? "text-attention" : "text-ink-soft") : ITEM_TONE[i.status]}>
                      {draft ? (i.changed ? "amount changed since added; will be skipped" : i.approvalNote ? i.approvalNote : stateLabel(i.state ?? "")) : ITEM_LABEL[i.status] ?? i.status}
                      {draft && !i.changed && !i.approvalNote && i.warnings.length ? <span className="block text-xs text-attention">Has {i.warnings.length === 1 ? "a warning" : `${i.warnings.length} warnings`}; release leaves it for its own page unless it is approved here first: {i.warnings.join("; ")}</span> : null}
                      {draft && reading.get(i.obligationId) ? (
                        <span className="block text-xs text-attention">
                          {reading.get(i.obligationId)!.chips.map((c) => (
                            <span key={c} className="dense mr-1.5 inline-block whitespace-nowrap rounded-sm px-1.5 align-[1px]" style={{ background: "var(--sheet)", boxShadow: "inset 0 0 0 1px var(--attention)" }}>
                              {c}
                            </span>
                          ))}
                          {reading.get(i.obligationId)!.note}
                        </span>
                      ) : null}
                      {draft && i.leftWhy === "second" ? <span className="block text-xs text-attention">Needs a second approver as well; release leaves it for its own page</span> : null}
                      {!draft && i.message ? <span className="block text-xs text-ink-soft">{i.message}</span> : null}
                    </td>
                    <td className="hidden sm:table-cell">{i.rail ? <RailTag rail={i.rail} /> : <span className="text-ink-soft">none</span>}</td>
                    <td className="r num whitespace-nowrap">{formatMoney(i.amountMinor, i.currency)}</td>
                    {draft && (canBuild || canApproveHere) ? (
                      <td className="r whitespace-nowrap">
                        {i.canApprove ? <ApproveItem obligationId={i.obligationId} fingerprints={i.fingerprints} label={`Approve ${formatMoney(i.amountMinor, i.currency)} to ${i.vendorName ?? "this vendor"}`} /> : null}{" "}
                        {canBuild ? <RemoveItem runId={run.id} itemId={i.id} /> : null}
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
