import Link from "next/link";
import { getBusiness, listSettlements } from "@/lib/queries";
import { toBaseOrZero } from "@/lib/fx";
import { formatDate, formatDateTime, formatMoneySymbol, pluralise, truncateMiddle } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState, Money, PageHeader, RailTag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ledger" };

export default function LedgerPage() {
  const rows = listSettlements();
  const base = getBusiness()?.baseCurrency ?? "USD";
  const gross = rows.reduce((a, r) => a + toBaseOrZero(r.grossMinor, r.grossCurrency, base), 0);
  const fees = rows.reduce((a, r) => a + toBaseOrZero(r.feeMinor, r.grossCurrency, base), 0);
  const mixed = rows.some((r) => r.grossCurrency !== base);
  return (
    <>
      <PageHeader title="Ledger" lede={rows.length ? `${pluralise(rows.length, "settlement")}, ${mixed ? "about " : ""}${formatMoneySymbol(gross, base)} paid, ${formatMoneySymbol(fees, base)} in fees${mixed ? ` (local-currency payments at reference rates)` : ""}.` : "Every settled payment, with what the recipient actually received."} />
      {rows.length === 0 ? (
        <EmptyState title="No settlements yet" body="Payments appear here once a rail confirms them." action={<Link href="/obligations?filter=needs_action" className="btn">Open inbox</Link>} />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Vendor</th>
                <th scope="col" className="hidden sm:table-cell">
                  Reference
                </th>
                <th scope="col">Rail</th>
                <th scope="col" className="r">
                  Gross
                </th>
                <th scope="col" className="r hidden md:table-cell">
                  Fee
                </th>
                <th scope="col" className="r">
                  Recipient received
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  External id
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="num whitespace-nowrap text-ink-soft" title={formatDateTime(s.settledAt)}>
                    {formatDate(s.settledAt)}
                  </td>
                  <td className="font-medium">
                    <Link href={`/obligations/${s.obligationId}`} className="hover:underline">
                      {s.vendorName ?? "Unknown vendor"}
                    </Link>
                  </td>
                  <td className="num hidden text-ink-soft sm:table-cell">{s.obligation.sourceRef ?? "none"}</td>
                  <td>
                    <RailTag rail={s.rail} />
                  </td>
                  <td className="r">
                    <Money minor={s.grossMinor} currency={s.grossCurrency} />
                  </td>
                  <td className="r hidden text-ink-soft md:table-cell">
                    <Money minor={s.feeMinor} currency={s.grossCurrency} />
                  </td>
                  <td className="r">{s.receivedMinor !== null ? <Money minor={s.receivedMinor} currency={s.receivedCurrency} /> : <span className="text-ink-soft">pending</span>}</td>
                  <td className="hidden lg:table-cell">
                    {s.externalId ? (
                      <span className="flex items-center gap-1">
                        <span className="num text-ink-soft" title={s.externalId}>
                          {truncateMiddle(s.externalId, 6)}
                        </span>
                        <CopyButton value={s.externalId} label={`Copy external id for ${s.obligation.sourceRef ?? s.vendorName ?? "settlement"}`} />
                        {s.explorerUrl ? (
                          <a href={s.explorerUrl} target="_blank" rel="noreferrer" className="link dense ml-1">
                            explorer
                          </a>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-ink-soft">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
