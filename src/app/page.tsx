import Link from "next/link";
import { TOUCH_INLINE } from "@/components/RequestPanels";
import { getViewer } from "@/lib/viewer";
import { runAs } from "@/lib/engine/requestContext";
import { findObligationsBySourceRef, getOverview, listAudit, listObligations, listPaymentPoints, waitingFor } from "@/lib/queries";
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
import { CountUp } from "@/components/motion/CountUp";
import { DemoVisit } from "@/components/DemoProgress";
import { waitingLine } from "@/components/waiting-line";

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
  // "Waiting on you" is this viewer's own list (the sidebar and the Inbox tab); "Needs someone" is everything that needs somebody.
  const line = waitingLine({ mine: viewer ? runAs(viewer.login, () => waitingFor(viewer.actor)) : null, needsSomeone: o.counts.needsAction });
  const extra = [line.rest, o.counts.scheduled ? `${pluralise(o.counts.scheduled, "payment")} scheduled by autopilot.` : null, o.counts.inFlight ? `${pluralise(o.counts.inFlight, "payment")} in flight.` : null].filter(Boolean);
  // The headline is the job: how many requests wait on this viewer. The business name sits above it, small.
  const heading = (
    <>
      <p className="text-sm text-ink-soft">{o.business?.name ?? "Checkrail Pay"}</p>
      <h1 className="mt-1 text-[34px] font-bold leading-[40px] tracking-[-0.03em]">
        {line.leadHref ? (
          <Link href={line.leadHref} className="decoration-[color:var(--rule-strong)] decoration-2 underline-offset-[6px] hover:underline">
            {line.lead.replace(/\.$/, "")}
          </Link>
        ) : (
          line.lead.replace(/\.$/, "")
        )}
      </h1>
      {extra.length ? (
        <p className="mt-2 text-[15px] text-ink-soft">
          {line.rest && line.restHref ? (
            <Link href={line.restHref} className="link">
              {line.rest}
            </Link>
          ) : (
            line.rest
          )}
          {extra.slice(line.rest ? 1 : 0).map((t) => ` ${t}`)}
        </p>
      ) : null}
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

      {/* One dark card leads: the money Checkrail stopped is the number to remember. */}
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Figure hero label="Errors prevented" value={<CountUp minor={o.money.preventedMinor} currency={base} />} note={<Link href="/exceptions" className="underline decoration-[color:var(--hero-soft)] underline-offset-[3px] hover:decoration-current">overpaid parts and duplicates, since day one</Link>} />
        <Figure label="Needs someone" value={String(o.counts.needsAction)} note={o.counts.blocked ? `${o.counts.blocked} blocked` : "none blocked"} tone={o.counts.needsAction ? "attention" : undefined} />
        <Figure label="Outstanding" value={formatMoneySymbol(o.money.outstandingMinor, base)} note={`${pluralise(o.counts.open, "open request")}, ${o.counts.blocked} blocked held back`} />
        <Figure label="Paid today" value={formatMoneySymbol(o.money.paidTodayMinor, base)} note={o.money.paidTodayCount ? pluralise(o.money.paidTodayCount, "payment") : "nothing settled yet today"} tone={o.money.paidTodayCount ? "settled" : undefined} />
      </dl>

      <BookLine rows={all} currency={base} />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Needs someone" aside={<Link href="/obligations?filter=needs_action" className="link">Open inbox</Link>} padded={false}>
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
                      <Link href={`/obligations/${a.obligationId}`} className={`font-medium hover:underline ${TOUCH_INLINE}`}>
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

      {/* The decisions come before the history: Money out is context, Needs someone is the job. */}
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

function Figure({ label, value, note, tone, hero = false }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: "attention" | "settled" | "blocked"; hero?: boolean }) {
  const colour = tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : tone === "blocked" ? "text-blocked" : "";
  return (
    <div className={`panel min-w-0 px-5 py-4 sm:px-6 sm:py-5 ${hero ? "panel-hero" : ""}`}>
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1.5 text-[28px] leading-[34px] sm:text-[32px] sm:leading-[38px] ${colour}`}>{value}</dd>
      {note ? <dd className="mt-1 text-[13px] leading-[18px] text-ink-soft">{note}</dd> : null}
    </div>
  );
}
