import Link from "next/link";
import { getSystemModes, listAccountingSyncs } from "@/lib/queries";
import { formatDate, formatDateTime, groupThousands, pluralise } from "@/lib/format";
import { EmptyState, PageHeader, RailTag } from "@/components/ui";
import { ExportCsvButton } from "@/components/ExportCsvButton";
import { DemoVisit } from "@/components/DemoProgress";
import { ExportXeroBills } from "@/components/ExportXeroBills";
import { XeroPushSummary } from "@/components/XeroConnection";
import { listBillExports, xeroBillRows } from "@/lib/accounting/xeroBills";
import { BillExportHistory } from "@/components/BillExportHistory";
import { accountName } from "@/lib/accounting/billLine";
import { accountNamesFor } from "@/lib/accounting/record";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { auditEntries, obligations } from "@/lib/db/schema";
import { ZERO_DECIMAL_CURRENCIES } from "@/lib/domain/money";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounting" };

export default function AccountingPage() {
  const rows = listAccountingSyncs();
  const biz = getBusiness();
  const newBills = biz ? xeroBillRows(getDb(), biz.id, { onlyNew: true }).rows.length : 0;
  const exports = biz ? listBillExports(getDb(), biz.id) : [];
  const nameOf = accountNamesFor(getDb(), biz?.id);
  const pending = rows.filter((r) => r.status === "pending");
  const system = getSystemModes();
  // One currency across every record: say it once in the column headers, not in every cell.
  const currencies = [...new Set(rows.map((r) => r.payload.grossCurrency ?? "USD"))];
  const single = currencies.length === 1 ? currencies[0] : null;
  // Thousands separators for every amount, and whole units for a currency without decimals, whatever the record stored.
  const shown = (v: string | number, cur: string) => (ZERO_DECIMAL_CURRENCIES.has(cur) && Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }) : groupThousands(v));
  const amount = (v: string | number | null | undefined, cur: string) => (v == null || v === "" ? "" : single ? shown(v, cur) : `${cur} ${shown(v, cur)}`);
  // Bills changed here after they went to Xero: the accountant makes the same change there.
  const changed = getDb()
    .select({ obligationId: auditEntries.obligationId, at: auditEntries.createdAt, detail: auditEntries.detailJson, ref: obligations.sourceRef })
    .from(auditEntries)
    .innerJoin(obligations, eq(obligations.id, auditEntries.obligationId))
    .where(eq(auditEntries.action, "accounting.changed_after_export"))
    .orderBy(desc(auditEntries.seq))
    .limit(20)
    .all();

  return (
    <>
      <DemoVisit page="accounting" />
      <PageHeader
        title="Accounting"
        lede={
          <>
            One record per settled payment: gross, fee, net (what left the bank account) and the account code. {pending.length ? `${pluralise(pending.length, "record")} waiting to be exported.` : "Everything exported."} Destination today is {system.accounting === "xero" ? "Xero" : "CSV"}.
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportXeroBills count={newBills} />
            <ExportCsvButton pendingCount={pending.length} />
            <a href="/api/accounting/pack" className="btn" download title="This month and last month">
              Bookkeeper pack (.xlsx)
            </a>
          </div>
        }
      />
      {changed.length ? (
        <div className="panel mb-5 border-attention px-4 py-3 text-sm">
          <p className="font-medium text-attention">Changed here after it went to Xero: make the same change in Xero.</p>
          <ul className="mt-1 space-y-0.5">
            {changed.map((c) => {
              const d = JSON.parse(c.detail ?? "{}") as { invoiceDate?: string | null; dueDate?: string | null };
              return (
                <li key={`${c.obligationId}-${c.at}`} className="num text-xs">
                  <Link href={`/obligations/${c.obligationId}`} className="link">
                    {c.ref ?? c.obligationId}
                  </Link>{" "}
                  on {formatDateTime(c.at)}: invoice date {d.invoiceDate ? formatDate(d.invoiceDate) : "none"}, due {d.dueDate ? formatDate(d.dueDate) : "none"}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <XeroPushSummary />
      <BillExportHistory exports={exports} />
      <section className="panel mb-5 px-4 py-3" aria-labelledby="files-heading">
        <h2 id="files-heading" className="font-medium">
          Which file is for what
        </h2>
        <dl className="mt-2 grid max-w-3xl gap-x-4 gap-y-2 text-sm sm:grid-cols-[13rem_1fr]">
          <dt className="font-medium">Bills CSV, to import</dt>
          <dd className="text-ink-soft">The only file to import into Xero (Business, Bills to pay, Import), in Xero&apos;s template. Bills go in when they are approved, not when they are paid, so aged payables are right while payments wait. A deposit and its balance are one bill, at the invoice&apos;s gross amount. Export new bills holds only bills not exported before.</dd>
          <dt className="font-medium">Bookkeeper pack (.xlsx), to read</dt>
          <dd className="text-ink-soft">
            For the accountant: a cover sheet with totals and how to use it with Xero, the bills, the payments with dates, amounts, fees, who paid each fee, the rate and account, and fees by rail and month. Not for importing. Up to 5,000 rows a sheet; the cover says if a period has more.{" "}
            <a className="link" href="/api/accounting/pack" download>
              This month and last month
            </a>
            {" or "}
            <a className="link" href="/api/accounting/pack?period=all" download>
              everything on record
            </a>
            .
          </dd>
          <dt className="font-medium">Settlement records CSV, to read</dt>
          <dd className="text-ink-soft">One row per settled payment, for the bookkeeper to match payments from the bank feed: gross, fee and who paid it, net (what left the bank account), recipient amount, account code and name, transaction id. Not for importing. Tax kept back from a vendor is a second payment on the bill from the withholding account, for the row&apos;s withheldAmount.</dd>
        </dl>
      </section>

      {rows.length === 0 ? (
        <EmptyState title="No accounting records yet" body="A record is queued the moment a payment settles." action={<Link href="/ledger" className="btn">Open ledger</Link>} />
      ) : (
        <>
        {/* Under 640px: two-line rows, the Inbox pattern (DS2-15). Vendor and gross, then reference, account code and status. */}
        <ul className="panel divide-y hairline sm:hidden">
          {rows.map((r) => {
            const p = r.payload;
            const cur = p.grossCurrency ?? "USD";
            const status = r.status === "pending" ? "Waiting" : r.status === "failed" ? "Failed" : r.status === "exported" ? "Exported" : r.status;
            const tone = r.status === "pending" ? "text-attention" : r.status === "failed" ? "text-blocked" : "text-settled";
            return (
              <li key={r.id}>
                <Link href={`/obligations/${r.obligationId}`} className="block min-h-11 px-4 py-3 active:bg-paper">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{p.vendorName ?? r.vendorName ?? "Unknown vendor"}</span>
                    <span className="num shrink-0 whitespace-nowrap font-medium">{p.grossAmount == null || p.grossAmount === "" ? "" : `${cur} ${shown(p.grossAmount, cur)}`}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-xs">
                    <span className="num min-w-0 truncate text-ink-soft">
                      {p.reference ?? r.obligation.sourceRef ?? "no reference"}
                      {p.accountCode ? `, ${String(p.accountCode).split(" ")[0]}` : ""}
                    </span>
                    <span className={`dense ml-auto inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 ${tone}`} style={{ background: r.status === "pending" ? "var(--attention-soft)" : r.status === "failed" ? "var(--blocked-soft)" : "var(--settled-soft)" }}>{status}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="panel overflow-x-auto max-sm:hidden">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Reference</th>
                <th scope="col">Vendor</th>
                <th scope="col" className="hidden sm:table-cell">
                  Rail
                </th>
                <th scope="col" className="r whitespace-nowrap">
                  Gross{single ? ` (${single})` : ""}
                </th>
                <th scope="col" className="r hidden whitespace-nowrap md:table-cell">
                  Fee{single ? ` (${single})` : ""}
                </th>
                <th scope="col" className="r whitespace-nowrap">
                  Net{single ? ` (${single})` : ""}
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  Account code
                </th>
                <th scope="col" className="hidden md:table-cell">
                  Destination
                </th>
                <th scope="col" className="hidden 2xl:table-cell">
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
                      <span className={`dense inline-flex h-5 items-center whitespace-nowrap rounded-sm px-1.5 ${r.status === "pending" ? "bg-attention-soft text-attention" : r.status === "failed" ? "bg-blocked-soft text-blocked" : "bg-settled-soft text-settled"}`}>{r.status === "pending" ? "Waiting" : r.status === "failed" ? "Failed" : r.status === "exported" ? "Exported" : r.status}</span>
                    </td>
                    <td className="num whitespace-nowrap">
                      <Link href={`/obligations/${r.obligationId}`} className="hover:underline">
                        {p.reference ?? r.obligation.sourceRef ?? "none"}
                      </Link>
                    </td>
                    <td className="min-w-[12rem] font-medium">{p.vendorName ?? r.vendorName ?? "Unknown vendor"}</td>
                    <td className="hidden sm:table-cell">
                      <RailTag rail={p.rail} />
                    </td>
                    <td className="r num whitespace-nowrap">{amount(p.grossAmount, cur)}</td>
                    <td className="r num hidden whitespace-nowrap text-ink-soft md:table-cell">{amount(p.feeAmount, cur)}</td>
                    <td className="r num whitespace-nowrap">{amount(p.netPaid, cur)}</td>
                    <td className="hidden text-ink-soft lg:table-cell">
                      <span className="block max-w-[6rem] truncate" title={p.accountCode ? `${String(p.accountCode).split(" ")[0]} ${nameOf(String(p.accountCode).split(" ")[0]) ?? (accountName(String(p.accountCode).split(" ")[0]) || p.accountName || "")}`.trim() : undefined}>
                        {p.accountCode ? String(p.accountCode).split(" ")[0] : ""}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap text-ink-soft md:table-cell" title={r.externalRef ?? undefined}>
                      {destinationLabel(r.destination, r.externalRef)}
                    </td>
                    <td className="num hidden whitespace-nowrap text-ink-soft 2xl:table-cell" title={formatDateTime(r.createdAt)}>
                      {formatDate(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </>
  );
}

/** "CSV, 21 Oct" for an exported CSV record, "Xero" with its id in the title, "CSV, not yet" while it waits. */
function destinationLabel(destination: string, externalRef: string | null): string {
  const name = destination === "xero" ? "Xero" : destination === "csv" ? "CSV" : destination;
  const m = externalRef?.match(/^csv:(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}T00:00:00Z`);
    return `${name}, ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  }
  if (!externalRef) return `${name}, not yet`;
  return name;
}
