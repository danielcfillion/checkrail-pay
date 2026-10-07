import Link from "next/link";
import { getOverview, listObligations } from "@/lib/queries";
import { formatMoney, formatMoneySymbol, humaniseAction, humaniseActor, pluralise } from "@/lib/format";
import { BookLine } from "@/components/BookLine";
import { NeedsYouList } from "@/components/ObligationList";
import { ResetDemoButton } from "@/components/ResetDemoButton";
import { EmptyState, Panel, RelativeTime } from "@/components/ui";
import { AutopilotStrip } from "@/components/AutopilotStrip";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const o = getOverview();
  const all = listObligations({ limit: 1000 });
  const base = o.business?.baseCurrency ?? "USD";
  const rails = o.money.byRail;
  const maxGross = Math.max(rails.paypal.grossMinor, rails.stellar.grossMinor, 1);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{o.business?.name ?? "Dueline"}</h1>
          <p className="mt-1 text-ink-soft">
            {o.counts.needsAction === 0 ? "Nothing needs you right now." : `${pluralise(o.counts.needsAction, "obligation")} need${o.counts.needsAction === 1 ? "s" : ""} you.`}
            {o.counts.scheduled ? ` ${pluralise(o.counts.scheduled, "payment")} scheduled by autopilot.` : ""}
            {o.counts.inFlight ? ` ${pluralise(o.counts.inFlight, "payment")} in flight.` : ""}
          </p>
        </div>
        <ResetDemoButton />
      </header>

      {o.business ? <AutopilotStrip businessId={o.business.id} currency={base} /> : null}

      <BookLine rows={all} />

      <dl className="mt-6 grid grid-cols-2 gap-y-4 border-y hairline py-4 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-[color:var(--rule)]">
        <Figure label="Needs you" value={String(o.counts.needsAction)} note={o.counts.blocked ? `${o.counts.blocked} blocked` : "none blocked"} tone={o.counts.needsAction ? "attention" : undefined} />
        <Figure label="Outstanding" value={formatMoneySymbol(o.money.outstandingMinor, base)} note={`${pluralise(o.counts.open, "open obligation")}, ${o.counts.blocked} blocked held back`} />
        <Figure label="Paid, last 30 days" value={formatMoneySymbol(o.money.paid30dMinor, base)} note={pluralise(o.counts.settled30d, "settlement")} tone="settled" />
        <Figure label="Fees, last 30 days" value={formatMoneySymbol(o.money.fees30dMinor, base)} note={o.money.paid30dMinor ? `${((o.money.fees30dMinor / o.money.paid30dMinor) * 100).toFixed(1)}% of paid` : "no payments yet"} />
        <Figure label="Errors prevented" value={formatMoneySymbol(o.money.preventedMinor, base)} note={<Link href="/exceptions" className="link">overpayments and duplicates</Link>} tone={o.money.preventedMinor ? "blocked" : undefined} />
      </dl>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Needs you" aside={<Link href="/obligations?filter=needs_action" className="link">Open inbox</Link>} padded={false}>
          {o.needsAction.length ? <NeedsYouList rows={o.needsAction} /> : <div className="px-4 py-8 text-center text-ink-soft">Nothing waiting. New requests appear here when the agent reads them.</div>}
        </Panel>

        <div className="space-y-6">
          <Panel title="Rail split, last 30 days">
            {o.money.paid30dMinor === 0 ? (
              <p className="text-ink-soft">No settlements in the last 30 days.</p>
            ) : (
              <div className="space-y-4">
                <RailBar rail="PayPal" colour="var(--paypal)" soft="var(--paypal-soft)" gross={rails.paypal.grossMinor} fee={rails.paypal.feeMinor} count={rails.paypal.count} max={maxGross} currency={base} />
                <RailBar rail="Stellar" colour="var(--stellar)" soft="var(--stellar-soft)" gross={rails.stellar.grossMinor} fee={rails.stellar.feeMinor} count={rails.stellar.count} max={maxGross} currency={base} />
              </div>
            )}
          </Panel>

          <Panel title="Recent activity" aside={<Link href="/audit" className="link">Full audit log</Link>} padded={false}>
            {o.recent.length ? (
              <ul className="divide-y hairline">
                {o.recent.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="text-ink-soft">{humaniseActor(a.actor)}</span> <span>{humaniseAction(a.action).toLowerCase()}</span>
                      </p>
                      {a.obligationId ? (
                        <Link href={`/obligations/${a.obligationId}`} className="num text-xs text-ink-soft hover:text-ink">
                          {a.vendorName ?? "Unknown vendor"}
                          {a.sourceRef ? `, ${a.sourceRef}` : ""}
                        </Link>
                      ) : null}
                    </div>
                    <RelativeTime iso={a.createdAt} className="shrink-0 text-xs text-ink-soft" />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-4 py-6 text-center text-ink-soft">No activity yet.</div>
            )}
          </Panel>
        </div>
      </div>

      {!o.business ? (
        <div className="mt-6">
          <EmptyState title="No business configured" body="Run the demo seed, or reset the demo above, to load Ridgeline Expeditions and its vendor roster." />
        </div>
      ) : null}
    </>
  );
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

function RailBar({ rail, colour, soft, gross, fee, count, max, currency }: { rail: string; colour: string; soft: string; gross: number; fee: number; count: number; max: number; currency: string }) {
  const pct = Math.max(2, Math.round((gross / max) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="dense" style={{ color: colour }}>
          {rail}
        </span>
        <span className="num">{formatMoney(gross, currency)}</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-sm" style={{ background: soft }} role="img" aria-label={`${rail}: ${formatMoney(gross, currency)} gross across ${pluralise(count, "payment")}`}>
        <div className="h-2 rounded-sm" style={{ width: `${gross ? pct : 0}%`, background: colour }} />
      </div>
      <p className="num mt-1 text-xs text-ink-soft">
        {pluralise(count, "payment")}, fees {formatMoney(fee, currency)}
        {gross ? ` (${((fee / gross) * 100).toFixed(1)}%)` : ""}
      </p>
    </div>
  );
}
