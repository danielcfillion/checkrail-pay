import Link from "next/link";
import { getDb } from "@/lib/db";
import { agentRecordFor } from "@/lib/agent/activity";
import { offerLine, offersForRequest, type OfferStatus, type OfferView } from "@/lib/agent/offers";
import type { ProvenanceLine } from "@/lib/agent/provenance";
import { formatDateTime, formatMoney, formatMoneySymbol } from "@/lib/format";
import { RelativeTime, TonePill } from "./ui";

/*
 * What the agent guard's newer features show people: where an agent's instruction came from (provenance), counter-offers
 * made to suppliers' agents, and how much is left under a spending mandate. Read-only and server-safe.
 */

/** One line per source: what it is for, a small kind pill, and the sender or label the agent gave. */
export function ProvenanceList({ lines, className = "" }: { lines: ProvenanceLine[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <ul className={`grid gap-1 text-xs ${className}`} aria-label="Where the agent said this came from">
      {lines.map((l, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="w-[92px] shrink-0 text-ink-soft">{l.what}</span>
          <TonePill tone={l.outside ? "attention" : l.trusted ? "settled" : "neutral"}>
            {l.kindLabel}
          </TonePill>
          {l.detail ? <span className="min-w-0 break-all text-ink-soft">{l.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

const OFFER_TONE: Record<OfferStatus, "attention" | "settled" | "muted" | "neutral"> = { open: "attention", accepted: "settled", disputed: "attention", expired: "muted" };
const OFFER_LABEL: Record<OfferStatus, string> = { open: "Waiting on the supplier", accepted: "Accepted", disputed: "Disputed", expired: "Expired" };

export function OfferPill({ status }: { status: OfferStatus }) {
  return <TonePill tone={OFFER_TONE[status]}>{OFFER_LABEL[status]}</TonePill>;
}

/** What became of an offer, in one sentence for people. */
export function offerOutcome(o: OfferView): string {
  if (o.status === "accepted") return `The supplier's agent accepted. A request for ${formatMoney(o.offerMinor, o.currency, { code: true })} went to the inbox, where the rules and approval still apply.`;
  if (o.status === "disputed") return "The supplier's agent disputed it. Its reason and records are on the request, as its own say-so; a person decides.";
  if (o.status === "expired") return "Nobody answered before it expired. Nothing was created.";
  return `Open until ${formatDateTime(o.expiresAt)}. Nothing is created until the supplier's agent answers.`;
}

/** Used versus the total under a mandate, with the numbers written out: colour is never the only signal. */
export function BudgetBar({ spentMinor, totalMinor, currency, active }: { spentMinor: number; totalMinor: number; currency: string; active: boolean }) {
  const pct = totalMinor > 0 ? Math.min(100, Math.round((spentMinor / totalMinor) * 100)) : 0;
  const tone = !active ? "var(--rule-strong)" : pct >= 100 ? "var(--blocked)" : pct >= 80 ? "var(--attention)" : "var(--settled)";
  const left = Math.max(0, totalMinor - spentMinor);
  return (
    <div>
      <div className="h-2 w-full rounded-sm" style={{ background: "var(--rule)" }} role="img" aria-label={`${formatMoneySymbol(spentMinor, currency)} used of ${formatMoneySymbol(totalMinor, currency)}, ${pct}%`}>
        <div className="h-2 rounded-sm" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <p className="num mt-1 flex justify-between gap-3 text-xs text-ink-soft">
        <span>
          {formatMoneySymbol(spentMinor, currency)} used of {formatMoneySymbol(totalMinor, currency)}
        </span>
        <span className={active && left === 0 ? "text-blocked" : undefined}>{active ? `${formatMoneySymbol(left, currency)} left` : "nothing left to use"}</span>
      </p>
    </div>
  );
}

/**
 * The request page's agent section: where the agent said the instruction came from, the mandate it asked under, and
 * any counter-offer made to a supplier's agent about this request, with what became of it.
 */
export function AgentGuardRecord({ obligationId }: { obligationId: string }) {
  const db = getDb();
  const asks = agentRecordFor(db, obligationId).filter((a) => a.tool === "request_payment");
  const offers = offersForRequest(db, obligationId);
  const withProvenance = asks.find((a) => a.provenance.length > 0);
  const mandate = asks.find((a) => a.mandateId);
  if (!asks.length && !offers.length) return null;
  return (
    <div className="mt-3 border-t pt-3 hairline">
      <p className="dense text-ink-soft">From the agent guard</p>
      {asks.length ? (
        <p className="mt-0.5">
          Requested by <span className="font-medium">{asks[0].agent}</span>, an outside agent, <RelativeTime iso={asks[0].createdAt} />.
          {mandate ? " Under a spending mandate from the owner, which only narrows what it may ask for." : ""}
        </p>
      ) : null}
      {withProvenance ? (
        <div className="mt-2">
          <p className="text-xs text-ink-soft">Where the agent said it came from</p>
          <ProvenanceList lines={withProvenance.provenance} className="mt-1" />
        </div>
      ) : asks.length ? (
        <p className="mt-1 text-xs text-ink-soft">The agent did not say where the instruction came from.</p>
      ) : null}
      {offers.map((o) => (
        <div key={o.id} className="mt-3 rounded border border-[color:var(--rule)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">Counter-offer to {o.vendorName}&apos;s agent</p>
            <OfferPill status={o.status} />
          </div>
          <p className="num mt-1 text-sm">{offerLine(o)}</p>
          <p className="mt-0.5 text-xs text-ink-soft">Based on {o.basis}.</p>
          <p className="mt-1 text-sm">{offerOutcome(o)}</p>
          {o.disputeReason ? (
            <blockquote className="mt-2 border-l-2 pl-3 text-sm text-ink-soft hairline">
              <span className="block text-xs">The supplier&apos;s agent says (its own say-so):</span>
              {o.disputeReason}
            </blockquote>
          ) : null}
          {o.obligationId === obligationId && o.resultObligationId && o.resultObligationId !== obligationId ? (
            <Link href={`/obligations/${o.resultObligationId}`} className="link mt-1 inline-block text-sm">
              The request it led to
            </Link>
          ) : o.resultObligationId === obligationId && o.obligationId && o.obligationId !== obligationId ? (
            <Link href={`/obligations/${o.obligationId}`} className="link mt-1 inline-block text-sm">
              The request the offer answered
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
