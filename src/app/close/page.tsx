import Link from "next/link";
import { TOUCH_INLINE } from "@/components/RequestPanels";
import { getViewer } from "@/lib/viewer";
import { getDb } from "@/lib/db";
import { runAs } from "@/lib/engine/requestContext";
import { getBusiness, listObligations, waitingIdsFor } from "@/lib/queries";
import { reasonFor } from "@/components/ObligationList";
import { readerNotesFor } from "@/lib/reading";
import { attentionIds, getDailyClose, listSignOffs, type AttentionItem, type CloseItem } from "@/lib/engine/dailyClose";
import { formatDateTime, formatMoney, formatMoneySymbol, humaniseAction, humaniseActor, pluralise, stateLabel } from "@/lib/format";
import { CapMeter } from "@/components/CapMeter";
import { plainReason } from "@/lib/activity";
import { ScheduledReleases } from "@/components/ScheduledReleases";
import { SignOffButton } from "@/components/SignOffButton";
import { EmptyState, Linkified, PageHeader, Panel, RailTag, RelativeTime } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Daily close" };

const KIND: Record<AttentionItem["kind"], { label: string; tone: string; next: string }> = {
  unknown_outcome: { label: "Outcome unclear", tone: "var(--blocked)", next: "Do not pay again. Open it and reconcile with the provider." },
  payout_exception: { label: "Payout needs attention", tone: "var(--attention)", next: "Sent but not received. Do not pay again; sort it out with the vendor." },
  returned: { label: "Money came back", tone: "var(--blocked)", next: "The vendor is owed again. Check their details, then pay it again." },
  failed: { label: "Payment failed", tone: "var(--blocked)", next: "Nothing moved. Retry, switch rail or cancel." },
  refused: { label: "Stopped at the last check", tone: "var(--attention)", next: "Something changed after it was scheduled. No money moved." },
  slow_settlement: { label: "Slow to settle", tone: "var(--attention)", next: "Sent, not yet confirmed by the provider." },
  blocked: { label: "Blocked by policy", tone: "var(--blocked)", next: "Correct it or cancel it." },
  cancelled_release: { label: "Release cancelled", tone: "var(--ink-soft)", next: "Still approved. Send by hand or cancel." },
  approved_over_warning: { label: "Approved over warnings", tone: "var(--attention)", next: "Paid. Worth a second look at why the warnings were accepted." },
  unusual_amount: { label: "Unusual amount", tone: "var(--attention)", next: "Paid. Confirm the job really was larger than usual." },
  new_vendor: { label: "New vendor", tone: "var(--ink-soft)", next: "Paid. Confirm the vendor received it." },
};

export default async function DailyClosePage() {
  const viewer = await getViewer();
  const biz = getBusiness();
  if (!biz) {
    return (
      <>
        <PageHeader title="Daily close" />
        <EmptyState title="No business configured" body="Reset the demo from the overview first." />
      </>
    );
  }
  const db = getDb();
  const c = getDailyClose(db, biz.id, biz.baseCurrency);
  const cur = c.baseCurrency;
  const past = listSignOffs(db, 5);
  // One meaning of "waiting on you" everywhere (the sidebar, the Inbox tab, the overview): what this viewer's role lets them do next.
  // Requests that wait on somebody else (evidence from the vendor, an approval above their limit) are listed under their own name.
  // A request that is both a problem of this period and still waiting is said so in both places, not left to look like two.
  const above = attentionIds(c.attention);
  const tagged = (id: string, note: string) => (above.has(id) ? `Also under Needs a look. ${note}` : note);
  const mineIds = viewer ? new Set(runAs(viewer.login, () => waitingIdsFor(viewer.actor))) : null;
  const mineRows = mineIds
    ? listObligations({ limit: 1000 })
        .filter((r) => mineIds.has(r.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((r) => ({ id: r.id, vendorName: r.vendorName, amountMinor: r.amountMinor, currency: r.currency, note: tagged(r.id, reasonFor(r) || stateLabel(r.state)) }))
    : c.waitingOnYou.map((w) => ({ id: w.id, vendorName: w.vendorName, amountMinor: w.amountMinor, currency: w.currency, note: tagged(w.id, w.note ? plainReason(w.note) : stateLabel(w.state)) }));
  const others = mineIds ? c.waitingOnYou.filter((w) => !mineIds.has(w.id)) : [];
  const scheduledNotes = readerNotesFor(c.scheduled.map((s) => s.id));
  const quiet = !c.attention.length && !c.paidByAgent.length && !c.paidByPeople.length && !c.settingsChanges.length;

  return (
    <>
      <PageHeader
        title="Daily close"
        lede={
          <>
            Everything since {c.sinceIsSignOff ? "the last sign-off" : "this time yesterday"} (<span className="num">{formatDateTime(c.since)}</span>). What needs a look comes first.
          </>
        }
        // On a phone the button waits at the end of the page, after what it attests to; on desktop it stays at the top.
        actions={!viewer || viewer.can("sign_off") ? <span className="max-lg:hidden"><SignOffButton throughSeq={c.throughSeq} attention={c.attention.length} /></span> : <span className="dense text-ink-soft max-lg:hidden">An approver or the owner signs off</span>}
      />

      <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Figure label="Needs a look" value={String(c.attention.length)} note={c.attention.length ? "listed below, most serious first" : "nothing flagged by the rules"} tone={c.attention.length ? "attention" : undefined} />
        <Figure label="Waiting on you" value={String(mineRows.length)} note={mineRows.length ? "the ones you can act on" : "nothing waiting on you"} tone={mineRows.length ? "attention" : undefined} />
        <Figure label="Sent by autopilot" value={formatMoneySymbol(c.totals.agentMinor, cur)} note={pluralise(c.totals.agentCount, "payment")} tone={c.totals.agentCount ? "settled" : undefined} />
        <Figure label="Sent by people" value={formatMoneySymbol(c.totals.peopleMinor, cur)} note={pluralise(c.totals.peopleCount, "payment")} />
        <Figure label="Held back" value={formatMoneySymbol(c.totals.stoppedMinor, cur)} note={`requested in ${pluralise(c.totals.stoppedCount, "request")} blocked or refused`} tone={c.totals.stoppedCount ? "blocked" : undefined} />
      </dl>

      {/* One column of panels in reading order, so the tab order is the visual order on a phone; from lg the cap and the sign-off history sit in a narrow column beside them. minmax(0, 1fr): a bare grid column is as wide as its widest content, which pushed the page past a phone's edge once a payment table was listed. */}
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Panel title="Needs a look" aside={c.attention.length ? `${c.attention.length}` : "clear"} padded={false}>
            {c.attention.length ? (
              <ul className="divide-y hairline">
                {c.attention.map((a) => (
                  <li key={`${a.kind}-${a.id}`} className="min-w-0 px-4 py-3" style={{ boxShadow: `inset 3px 0 0 ${KIND[a.kind].tone}` }}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p>
                        <span className="dense mr-2" style={{ color: KIND[a.kind].tone }}>
                          {KIND[a.kind].label}
                        </span>
                        <Link href={`/obligations/${a.id}`} className={`font-medium hover:underline ${TOUCH_INLINE}`}>
                          {a.vendorName ?? "Unknown vendor"}
                        </Link>{" "}
                        <span className="num text-ink-soft">{a.sourceRef ?? "no reference"}</span>
                      </p>
                      <span className="num font-medium">{formatMoney(a.amountMinor, a.currency)}</span>
                    </div>
                    {a.note ? (
                      <p className="mt-1 break-words [overflow-wrap:anywhere]">
                        <Linkified text={a.note} />
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {KIND[a.kind].next} <RelativeTime iso={a.at} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-ink-soft">Nothing failed, nothing was refused and nothing new is blocked.</p>
            )}
          </Panel>


          <Panel title="Still waiting on you" aside={mineRows.length ? `${mineRows.length}` : "none"} padded={false}>
            {mineRows.length ? (
              <ul className="divide-y hairline">
                {mineRows.map((w) => (
                  <li key={w.id}>
                    <Link href={`/obligations/${w.id}`} className="block px-4 py-2 hover:bg-paper/60">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{w.vendorName ?? "Unknown vendor"}</span>
                        <span className="num">{formatMoney(w.amountMinor, w.currency)}</span>
                      </span>
                      <span className="line-clamp-2 text-xs text-ink-soft">{w.note}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-center text-ink-soft">Nothing is waiting on you.</p>
            )}
          </Panel>

          {others.length ? (
            <Panel title="Waiting on someone else" aside={`${others.length}`} padded={false}>
              <ul className="divide-y hairline">
                {others.map((w) => (
                  <li key={w.id}>
                    <Link href={`/obligations/${w.id}`} className="block px-4 py-2 hover:bg-paper/60">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{w.vendorName ?? "Unknown vendor"}</span>
                        <span className="num">{formatMoney(w.amountMinor, w.currency)}</span>
                      </span>
                      <span className="line-clamp-2 text-xs text-ink-soft">{w.note ? plainReason(w.note) : stateLabel(w.state)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {c.scheduled.length ? (
            <Panel title="About to go out" aside={`${c.scheduled.length} scheduled`} padded={false}>
              <ScheduledReleases compact windowSeconds={c.autopilot.cancelWindowSeconds} canCancel={!viewer || viewer.can("stop")} rows={c.scheduled.map((s) => ({ id: s.id, vendorName: s.vendorName, amountText: formatMoney(s.amountMinor, s.currency), releaseAt: s.releaseAt, concern: scheduledNotes[s.id] ?? null }))} />
            </Panel>
          ) : null}

          <PaidPanel title="Sent by autopilot" empty={c.autopilot.level === "autopilot" ? "The agent sent nothing in this period." : "Autopilot is off, so the agent sent nothing."} rows={c.paidByAgent} />
          <PaidPanel title="Sent by people" empty="Nobody sent a payment by hand in this period." rows={c.paidByPeople} />

          {c.settingsChanges.length ? (
            <Panel title="Autonomy changes" padded={false}>
              <ul className="divide-y hairline">
                {c.settingsChanges.map((s, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <span>
                      <span className="text-ink-soft">{humaniseActor(s.actor)}</span> {humaniseAction(s.action).toLowerCase()}
                      {s.action === "autonomy.changed" && s.detail ? <span className="text-ink-soft">{changeText(s.detail, cur)}</span> : null}
                    </span>
                    <RelativeTime iso={s.at} className="shrink-0 text-xs text-ink-soft" />
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {quiet ? <p className="text-center text-ink-soft">A quiet period. Sign off to start the next one from here.</p> : null}
        </div>

        <div className="min-w-0 space-y-6">
          {c.autopilot.level === "autopilot" ? (
            <Panel title="Autopilot cap" aside={c.autopilot.paused ? "paused" : "on"}>
              <CapMeter label="Last 24 hours" usedMinor={c.autopilot.committed24hMinor} capMinor={c.autopilot.dailyCapMinor} currency={cur} />
            </Panel>
          ) : null}

          <Panel title="Past sign-offs" padded={false}>
            {past.length ? (
              <ul className="divide-y hairline">
                {past.map((p) => (
                  <li key={p.at} className="px-4 py-2">
                    <span className="flex items-baseline justify-between gap-3">
                      <span>{humaniseActor(p.actor)}</span>
                      <span className="num text-xs text-ink-soft">{formatDateTime(p.at)}</span>
                    </span>
                    {p.totals ? (
                      <span className="num block text-xs text-ink-soft">
                        {formatMoneySymbol(p.totals.agentMinor + p.totals.peopleMinor, cur)} sent, {pluralise(p.attentionCount, "item")} flagged
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-center text-ink-soft">No sign-offs yet. The first one starts the record.</p>
            )}
          </Panel>
          {/* Phones: the sign-off comes last, after what it attests to. */}
          {!viewer || viewer.can("sign_off") ? (
            <div className="lg:hidden">
              <SignOffButton throughSeq={c.throughSeq} attention={c.attention.length} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function PaidPanel({ title, rows, empty, className = "" }: { title: string; rows: CloseItem[]; empty: string; className?: string }) {
  // An empty list is one line, not a panel with a title bar and padding around nothing.
  if (!rows.length) {
    return (
      <p className={`min-w-0 px-1 text-ink-soft ${className}`}>
        <span className="font-medium text-ink">{title}.</span> {empty}
      </p>
    );
  }
  return (
    <Panel className={className} title={title} aside={pluralise(rows.length, "payment")} padded={false}>
      {/* Phones: two lines per payment, the whole row a link, so no column is cut off. */}
      <ul className="divide-y hairline sm:hidden">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/obligations/${r.id}`} className="block min-h-11 px-4 py-3 active:bg-paper">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.vendorName ?? "Unknown vendor"}</span>
                <span className="num shrink-0 whitespace-nowrap font-medium">{formatMoney(r.amountMinor, r.currency)}</span>
              </span>
              <span className="mt-1 flex items-center gap-2">
                <span className="num min-w-0 truncate text-xs text-ink-soft">{r.sourceRef ?? "no reference"}</span>
                <span className={`shrink-0 text-xs ${r.state === "settled" ? "text-settled" : "text-ink-soft"}`}>{r.state === "settled" ? "Settled" : "Sent, settling"}</span>
                <RailTag rail={r.rail} className="ml-auto shrink-0" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto max-sm:hidden">
        <table className="ledger">
          <thead>
            <tr>
              <th>Paid to</th>
              <th>Reference</th>
              <th>Rail</th>
              <th>Status</th>
              <th className="r">Fee</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="row-link">
                <td>
                  <Link href={`/obligations/${r.id}`} className="font-medium hover:underline">
                    {r.vendorName ?? "Unknown vendor"}
                  </Link>
                </td>
                <td className="num text-ink-soft">{r.sourceRef ?? ""}</td>
                <td>
                  <RailTag rail={r.rail} />
                </td>
                <td className={r.state === "settled" ? "text-settled" : ""}>{r.state === "settled" ? "Settled" : "Sent, settling"}</td>
                <td className="r num text-ink-soft">{r.feeMinor !== null && r.feeMinor !== undefined ? formatMoney(r.feeMinor, r.currency, { code: false }) : ""}</td>
                <td className="r num font-medium">{formatMoney(r.amountMinor, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function changeText(detail: Record<string, unknown>, cur: string): string {
  const from = (detail.from ?? {}) as Record<string, unknown>;
  const to = (detail.to ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (from.autonomy !== to.autonomy) parts.push(`${String(from.autonomy ?? "assist")} to ${String(to.autonomy)}`);
  if (from.perPaymentCap !== to.perPaymentCap) parts.push(`per-payment cap ${formatMoneySymbol(Number(to.perPaymentCap), cur)}`);
  if (from.dailyCap !== to.dailyCap) parts.push(`daily cap ${formatMoneySymbol(Number(to.dailyCap), cur)}`);
  if (from.windowSeconds !== to.windowSeconds) parts.push(`cancel window ${Math.round(Number(to.windowSeconds) / 60)} min`);
  return parts.length ? `: ${parts.join(", ")}` : "";
}

function Figure({ label, value, note, tone }: { label: string; value: string; note?: React.ReactNode; tone?: "attention" | "settled" | "blocked" }) {
  const colour = tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : tone === "blocked" ? "text-blocked" : "";
  return (
    <div className="panel min-w-0 px-5 py-4">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1.5 text-[26px] leading-8 ${colour}`}>{value}</dd>
      {note ? <dd className="mt-1 text-[13px] leading-[18px] text-ink-soft">{note}</dd> : null}
    </div>
  );
}
