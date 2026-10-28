import Link from "next/link";
import { getOverview, listObligations } from "@/lib/queries";
import { formatMoneySymbol, pluralise } from "@/lib/format";
import { CheckLine } from "@/components/CheckLine";
import { EmptyState, Money, PageHeader, RelativeTime, StatePill } from "@/components/ui";
import { ReasonText } from "@/components/ReasonText";
import { earlierPayments } from "@/lib/earlier-payment";

export const dynamic = "force-dynamic";

export default function ExceptionsPage() {
  const rows = listObligations({ states: ["blocked", "failed"], limit: 500 });
  const o = getOverview();
  const base = o.business?.baseCurrency ?? "USD";
  const blocked = rows.filter((r) => r.state === "blocked");
  const failed = rows.filter((r) => r.state === "failed");
  // Duplicate reasons name the original by its internal id; show its vendor and reference instead.
  const earlier = earlierPayments(rows.map((r) => r.blockedReason));

  return (
    <>
      <PageHeader
        title="Exceptions"
        lede={
          rows.length ? (
            <>
              Open now: <span className="num">{formatMoneySymbol(o.money.preventedOpenMinor, base)}</span> held back across {pluralise(blocked.length, "blocked request")}
              {failed.length ? `, ${pluralise(failed.length, "payment")} failed on the rail` : ""}. Since the first payment, policy has kept <span className="num">{formatMoneySymbol(o.money.preventedMinor, base)}</span> from going out wrong. Each one below tells you why and what to do.
            </>
          ) : (
            "Nothing is blocked or failed. When policy stops a payment, it lands here with the reason."
          )
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No exceptions" body="Blocked and failed payments appear here with the rule that caught them." action={<Link href="/obligations" className="btn">Open inbox</Link>} />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="panel relative hover:bg-paper/40">
              <div className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Link href={`/obligations/${r.id}`} className="font-medium after:absolute after:inset-0 after:content-['']">
                      {r.vendorName ?? "Unknown vendor"}
                    </Link>
                    <span className="num text-ink-soft">{r.sourceRef ?? "no reference"}</span>
                    <StatePill state={r.state} />
                  </div>
                  <div className="flex items-center gap-4">
                    <RelativeTime iso={r.updatedAt} className="text-xs text-ink-soft" />
                    <Money minor={r.amountMinor} currency={r.currency} className="font-medium" />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-4">
                  <CheckLine state={r.state} variant="compact" />
                  <p className="min-w-0 flex-1 text-blocked">
                    {r.blockedReason ? (
                      <span className="relative z-10 [&_a]:text-blocked [&_a]:decoration-current">
                        <ReasonText text={r.blockedReason} earlier={earlier} />
                      </span>
                    ) : (
                      "The rail rejected the payment. Open to retry or cancel."
                    )}
                  </p>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{nextStep(r.blockedReason, r.state)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function nextStep(reason: string | null, state: string): string {
  if (state === "failed") return "Retry on the same rail, try the other rail, or cancel.";
  if (/already used/.test(reason ?? "")) return "If this is really a second job, correct the reference. Otherwise cancel: the original was paid.";
  if (/says [A-Z]{3}/.test(reason ?? "")) return "Correct the amount to what the evidence says and policy re-runs, or cancel.";
  return "Open the request to review and correct it.";
}
