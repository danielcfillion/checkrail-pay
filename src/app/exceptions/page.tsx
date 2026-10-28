import Link from "next/link";
import { getOverview, listObligations } from "@/lib/queries";
import { formatMoneySymbol, pluralise } from "@/lib/format";
import { CheckLine } from "@/components/CheckLine";
import { EmptyState, Money, PageHeader, RelativeTime, StatePill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exceptions" };

export default function ExceptionsPage() {
  const rows = listObligations({ states: ["blocked", "failed"], limit: 500 });
  const o = getOverview();
  const base = o.business?.baseCurrency ?? "USD";
  const blocked = rows.filter((r) => r.state === "blocked");
  const failed = rows.filter((r) => r.state === "failed");

  return (
    <>
      <PageHeader
        title="Exceptions"
        lede={
          rows.length ? (
            <>
              Open now: <span className="num">{formatMoneySymbol(o.money.preventedOpenMinor, base)}</span> held back across {pluralise(blocked.length, "blocked obligation")}
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
            <li key={r.id} className="panel">
              <Link href={`/obligations/${r.id}`} className="block px-4 py-3 hover:bg-paper/40 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{r.vendorName ?? "Unknown vendor"}</span>
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
                  <p className="min-w-0 flex-1 text-blocked">{r.blockedReason ?? "The rail rejected the payment. Open to retry or cancel."}</p>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{nextStep(r.blockedReason, r.state)}</p>
              </Link>
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
  return "Open the obligation to review and correct it.";
}
