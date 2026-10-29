import Link from "next/link";
import { getViewer } from "@/lib/viewer";
import { findObligationsBySourceRef, getOverview, listAudit, listObligations, listPaymentPoints } from "@/lib/queries";
import { formatMoneySymbol, pluralise } from "@/lib/format";
import { activityFeed } from "@/lib/activity";
import { DemoBanner } from "@/components/DemoBanner";
import { BookLine } from "@/components/BookLine";
import { NeedsYouList } from "@/components/ObligationList";
import { ResetDemoButton } from "@/components/ResetDemoButton";
import { EmptyState, Panel, RelativeTime } from "@/components/ui";
import { AutopilotStrip } from "@/components/AutopilotStrip";
import { MoneyOut } from "@/components/MoneyOut";
import { AutoRefresh } from "@/components/AutoRefresh";
import { DemoVisit } from "@/components/DemoProgress";

export const dynamic = "force-dynamic";
// The root segment does not get the layout's title template, so spell it out.
export const metadata = { title: { absolute: "Overview, Checkrail Pay" } };

export default async function OverviewPage() {
  const viewer = await getViewer();
  const o = getOverview();
  const all = listObligations({ limit: 1000 });
  const base = o.business?.baseCurrency ?? "USD";
  const points = listPaymentPoints(120);
  const canReset = !viewer || viewer.can("reset_demo");
  const demo = Boolean(viewer?.personas);
  // The opening request of the demo story, for the banner's first button.
  const phuong = demo ? findObligationsBySourceRef(["INV-2026-0152"]).find((r) => r.vendorId === "ven_phuong") : undefined;
  const activity = activityFeed(listAudit(400), 10);
  const heading = (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{o.business?.name ?? "Checkrail Pay"}</h1>
      <p className="mt-0.5 text-ink-soft">Checks every supplier payment before money moves.</p>
      <p className="mt-2">
        {o.counts.needsAction === 0 ? (
          "Nothing needs you right now."
        ) : (
          <Link href="/obligations?filter=needs_action" className="link">
            {`${pluralise(o.counts.needsAction, "request")} need${o.counts.needsAction === 1 ? "s" : ""} you.`}
          </Link>
        )}
        {o.counts.scheduled ? ` ${pluralise(o.counts.scheduled, "payment")} scheduled by autopilot.` : ""}
        {o.counts.inFlight ? ` ${pluralise(o.counts.inFlight, "payment")} in flight.` : ""}
      </p>
    </>
  );

  return (
    <>
      <AutoRefresh seconds={10} />
      <DemoVisit page="overview" />
      {demo ? <DemoBanner startHref={phuong ? `/obligations/${phuong.id}` : "/demo"} canReset={canReset} heading={heading} /> : (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">{heading}</div>
          {canReset ? <ResetDemoButton /> : null}
        </header>
      )}

      {o.business ? <AutopilotStrip businessId={o.business.id} currency={base} can={viewer ? { stop: viewer.can("stop"), settings: viewer.can("settings") } : undefined} /> : null}

      <BookLine
        rows={all}
        currency={base}
        header={
          <dl className="grid grid-cols-2 gap-y-4 sm:grid-cols-4 sm:divide-x sm:divide-[color:var(--rule)]">
            <Figure label="Needs you" value={String(o.counts.needsAction)} note={o.counts.blocked ? `${o.counts.blocked} blocked` : "none blocked"} tone={o.counts.needsAction ? "attention" : undefined} />
            <Figure label="Paid today" value={formatMoneySymbol(o.money.paidTodayMinor, base)} note={o.money.paidTodayCount ? pluralise(o.money.paidTodayCount, "payment") : "nothing settled yet today"} tone={o.money.paidTodayCount ? "settled" : undefined} />
            <Figure label="Outstanding" value={formatMoneySymbol(o.money.outstandingMinor, base)} note={`${pluralise(o.counts.open, "open request")}, ${o.counts.blocked} blocked held back`} />
            <Figure label="Errors prevented" value={formatMoneySymbol(o.money.preventedMinor, base)} note={<Link href="/exceptions" className="link">overpaid parts and duplicates, since day one</Link>} tone={o.money.preventedMinor ? "blocked" : undefined} />
          </dl>
        }
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Needs you" aside={<Link href="/obligations?filter=needs_action" className="link">Open inbox</Link>} padded={false}>
          {o.needsAction.length ? <NeedsYouList rows={o.needsAction} /> : <div className="px-4 py-8 text-center text-ink-soft">Nothing waiting. New requests appear here when the agent reads them.</div>}
        </Panel>

        <div className="space-y-6">
          <Panel title="Live activity" aside={<Link href="/audit" className="link">Full audit log</Link>} padded={false}>
            {activity.length ? (
              <ul className="divide-y hairline">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-3 px-4 py-2.5">
                    <span aria-hidden className="mt-1.5 inline-block h-2 w-2 shrink-0 self-start rounded-full" style={{ background: a.tone === "blocked" ? "var(--blocked)" : a.tone === "attention" ? "var(--attention)" : a.tone === "settled" ? "var(--settled)" : "var(--ink-soft)" }} />
                    <p className="min-w-0 flex-1">
                      <Link href={`/obligations/${a.obligationId}`} className="font-medium hover:underline">
                        {a.vendorName ?? "Unknown vendor"}
                      </Link>
                      {a.sourceRef ? <span className="num whitespace-nowrap text-ink-soft"> {a.sourceRef}</span> : null} <span className={a.tone === "blocked" ? "text-blocked" : a.tone === "attention" ? "text-attention" : ""}>{a.text}</span>
                    </p>
                    <RelativeTime iso={a.at} className="shrink-0 text-xs text-ink-soft" />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-4 py-6 text-center text-ink-soft">Nothing has happened yet. Blocks, approvals and payments appear here.</div>
            )}
          </Panel>
        </div>
      </div>

      {/* The decisions come before the history: Money out is context, Needs you is the job. */}
      <div className="mt-6">
        <MoneyOut points={points} currency={base} />
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
    <div className="px-1 sm:px-5 sm:first:pl-0">
      <dt className="dense text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1 text-2xl ${colour}`}>{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-ink-soft">{note}</dd> : null}
    </div>
  );
}
