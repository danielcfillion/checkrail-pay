import Link from "next/link";
import { TOUCH_INLINE } from "@/components/RequestPanels";
import { getViewer } from "@/lib/viewer";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getDailyClose, listSignOffs, type AttentionItem, type CloseItem } from "@/lib/engine/dailyClose";
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

      <dl className="grid grid-cols-2 gap-y-4 border-y hairline py-4 lg:grid-cols-5 lg:divide-x lg:divide-[color:var(--rule)]">
        <Figure label="Needs a look" value={String(c.attention.length)} note={c.attention.length ? "listed below, most serious first" : "nothing unusual"} tone={c.attention.length ? "attention" : undefined} />
        <Figure label="Waiting on you" value={String(c.waitingOnYou.length)} note={c.waitingOnYou.length ? "approvals and sends" : "nothing waiting"} tone={c.waitingOnYou.length ? "attention" : undefined} />
        <Figure label="Sent by autopilot" value={formatMoneySymbol(c.totals.agentMinor, cur)} note={pluralise(c.totals.agentCount, "payment")} tone={c.totals.agentCount ? "settled" : undefined} />
        <Figure label="Sent by people" value={formatMoneySymbol(c.totals.peopleMinor, cur)} note={pluralise(c.totals.peopleCount, "payment")} />
        <Figure label="Held back" value={formatMoneySymbol(c.totals.stoppedMinor, cur)} note={`requested in ${pluralise(c.totals.stoppedCount, "request")} blocked or refused`} tone={c.totals.stoppedCount ? "blocked" : undefined} />
      </dl>

      {/* minmax(0, 1fr) below lg: a bare grid column is as wide as its widest content, which pushed the page past a phone's edge once a payment table was listed. */}
      {/* On a phone the two columns dissolve so each panel can be ordered: what needs a look, then what waits on you. */}
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="contents lg:block lg:min-w-0 lg:space-y-6">
          <Panel className="order-1 lg:order-none" title="Needs a look" aside={c.attention.length ? `${c.attention.length}` : "clear"} padded={false}>
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

          <PaidPanel className="order-4 lg:order-none" title="Sent by autopilot" empty={c.autopilot.level === "autopilot" ? "The agent sent nothing in this period." : "Autopilot is off, so the agent sent nothing."} rows={c.paidByAgent} />
          <PaidPanel className="order-5 lg:order-none" title="Sent by people" empty="Nobody sent a payment by hand in this period." rows={c.paidByPeople} />

          {c.settingsChanges.length ? (
            <Panel className="order-7 lg:order-none" title="Autonomy changes" padded={false}>
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

          {quiet ? <p className="order-8 text-center text-ink-soft lg:order-none">A quiet period. Sign off to start the next one from here.</p> : null}
        </div>

        <div className="contents lg:block lg:min-w-0 lg:space-y-6">
          {c.autopilot.level === "autopilot" ? (
            <Panel className="order-6 lg:order-none" title="Autopilot cap" aside={c.autopilot.paused ? "paused" : "on"}>
              <CapMeter label="Last 24 hours" usedMinor={c.autopilot.committed24hMinor} capMinor={c.autopilot.dailyCapMinor} currency={cur} />
            </Panel>
          ) : null}

          {c.scheduled.length ? (
            <Panel className="order-3 lg:order-none" title="About to go out" aside={`${c.scheduled.length} scheduled`} padded={false}>
              <ScheduledReleases compact windowSeconds={c.autopilot.cancelWindowSeconds} canCancel={!viewer || viewer.can("stop")} rows={c.scheduled.map((s) => ({ id: s.id, vendorName: s.vendorName, amountText: formatMoney(s.amountMinor, s.currency), releaseAt: s.releaseAt }))} />
            </Panel>
          ) : null}

          <Panel className="order-2 lg:order-none" title="Still waiting on you" aside={c.waitingOnYou.length ? `${c.waitingOnYou.length}` : "none"} padded={false}>
            {c.waitingOnYou.length ? (
              <ul className="divide-y hairline">
                {c.waitingOnYou.map((w) => (
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
            ) : (
              <p className="px-4 py-5 text-center text-ink-soft">Nothing is waiting for a person.</p>
            )}
          </Panel>

          <Panel className="order-9 lg:order-none" title="Past sign-offs" padded={false}>
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
            <div className="order-10 lg:hidden">
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
    <div className="px-1 lg:px-5 lg:first:pl-1">
      <dt className="dense text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1 text-2xl ${colour}`}>{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-ink-soft">{note}</dd> : null}
    </div>
  );
}
