import Link from "next/link";
import { getBusiness, listAccountingSyncs, listSettlements, paymentStarters } from "@/lib/queries";
import { toBaseOrZero } from "@/lib/fx";
import { formatMoneySymbol, pluralise } from "@/lib/format";
import { EmptyState, PageHeader } from "@/components/ui";
import { LedgerGrid } from "@/components/grid/LedgerGrid";
import { toLedgerRow } from "@/components/grid/model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ledger" };

export default function LedgerPage() {
  const settlements = listSettlements();
  const base = getBusiness()?.baseCurrency ?? "USD";
  const toBase = (minor: number, currency: string) => toBaseOrZero(minor, currency, base);
  const gross = settlements.reduce((a, r) => a + toBase(r.grossMinor, r.grossCurrency), 0);
  const fees = settlements.reduce((a, r) => a + toBase(r.feeMinor, r.grossCurrency), 0);
  const mixed = settlements.some((r) => r.grossCurrency !== base);

  // Plain rows for the client grid: who started each payment, and whether its record reached the books.
  const starters = paymentStarters();
  const accounting = new Map<string, string>();
  for (const a of listAccountingSyncs()) if (!accounting.has(a.obligationId) || a.status !== "pending") accounting.set(a.obligationId, a.status);
  const rows = settlements.map((s) => toLedgerRow(s, { toBase, starter: starters.get(s.obligationId), accountingStatus: accounting.get(s.obligationId) }));

  return (
    <>
      <PageHeader
        title="Ledger"
        lede={
          rows.length
            ? `${pluralise(rows.length, "settlement")}, ${mixed ? "about " : ""}${formatMoneySymbol(gross, base)} paid, ${formatMoneySymbol(fees, base)} in fees${mixed ? ` (local-currency payments at reference rates)` : ""}.`
            : "Every settled payment, with what the recipient actually received."
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No settlements yet" body="Payments appear here once a rail confirms them." action={<Link href="/obligations?filter=needs_action" className="btn">Open inbox</Link>} />
      ) : (
        <LedgerGrid rows={rows} />
      )}
    </>
  );
}
