import Link from "next/link";
import { getSystemModes, listAccountingSyncs } from "@/lib/queries";
import { formatDate, formatDateTime, pluralise } from "@/lib/format";
import { EmptyState, PageHeader, RailTag } from "@/components/ui";
import { ExportCsvButton } from "@/components/ExportCsvButton";

export const dynamic = "force-dynamic";

export default function AccountingPage() {
  const rows = listAccountingSyncs();
  const pending = rows.filter((r) => r.status === "pending");
  const system = getSystemModes();

  return (
    <>
      <PageHeader
        title="Accounting"
        lede={
          <>
            One record per settled payment: gross, fee, net and the account code. {pending.length ? `${pluralise(pending.length, "record")} waiting to be exported.` : "Everything exported."} Destination today is {system.accounting === "xero" ? "Xero" : "CSV"}.
          </>
        }
        actions={
          <ExportCsvButton pendingCount={pending.length} />
        }
      />
      <p className="mb-5 max-w-3xl text-ink-soft">Xero is the first live destination. The CSV carries the same record shape (reference, vendor, bill date, gross, fee, net, recipient amount, rail, external transaction id, account code), so the books look identical whichever path the record took.</p>

      {rows.length === 0 ? (
        <EmptyState title="No accounting records yet" body="A record is queued the moment a payment settles." action={<Link href="/ledger" className="btn">Open ledger</Link>} />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Reference</th>
                <th scope="col">Vendor</th>
                <th scope="col" className="hidden sm:table-cell">
                  Rail
                </th>
                <th scope="col" className="r">
                  Gross
                </th>
                <th scope="col" className="r hidden md:table-cell">
                  Fee
                </th>
                <th scope="col" className="r">
                  Net
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  Account code
                </th>
                <th scope="col" className="hidden md:table-cell">
                  Destination
                </th>
                <th scope="col" className="hidden xl:table-cell">
                  Queued
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.payload;
                const cur = p.grossCurrency ?? "USD";
                return (
                  <tr key={r.id}>
                    <td>
                      <span className={`dense ${r.status === "pending" ? "text-attention" : r.status === "failed" ? "text-blocked" : "text-settled"}`}>{r.status}</span>
                    </td>
                    <td className="num">
                      <Link href={`/obligations/${r.obligationId}`} className="hover:underline">
                        {p.reference ?? r.obligation.sourceRef ?? "none"}
                      </Link>
                    </td>
                    <td className="font-medium">{p.vendorName ?? r.vendorName ?? "Unknown vendor"}</td>
                    <td className="hidden sm:table-cell">
                      <RailTag rail={p.rail} />
                    </td>
                    <td className="r num">
                      {cur} {p.grossAmount ?? ""}
                    </td>
                    <td className="r num hidden text-ink-soft md:table-cell">
                      {cur} {p.feeAmount ?? ""}
                    </td>
                    <td className="r num">
                      {cur} {p.netPaid ?? ""}
                    </td>
                    <td className="hidden text-ink-soft lg:table-cell">{p.accountCode ?? ""}</td>
                    <td className="hidden text-ink-soft md:table-cell">
                      {r.destination}
                      {r.externalRef ? <span className="num text-xs"> ({r.externalRef})</span> : null}
                    </td>
                    <td className="num hidden text-ink-soft xl:table-cell" title={formatDateTime(r.createdAt)}>
                      {formatDate(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
