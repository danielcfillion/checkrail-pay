import Link from "next/link";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { listBatches } from "@/lib/engine/bankFiles";
import { bankFileSource } from "@/lib/rails/localQuotes";
import { formatDateTime, formatMoney } from "@/lib/format";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { ConfirmBankFile, ReturnLine } from "@/components/BankFileActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bank files" };

const STATUS: Record<string, string> = { open: "open: payments are joining it", downloaded: "downloaded: waiting for the bank", confirmed: "confirmed paid" };

export default async function BankFilesPage() {
  const biz = getBusiness();
  if (!biz) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;
  const viewer = await getViewer();
  const batches = listBatches(getDb(), biz.id);
  const source = bankFileSource();
  const canPay = !viewer || viewer.can("pay");
  const canConfirm = !viewer || viewer.can("pay") || viewer.can("reconcile");
  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/runs" className="hover:text-ink">
          Payment runs
        </Link>
        <span aria-hidden> / </span>
        Bank files
      </nav>
      <PageHeader
        title="Bank files"
        lede={
          source
            ? `VND payments routed to the bank file collect here, paid from ${source}. Download the file, upload it in corporate banking, then confirm once the bank shows it paid. Downloading freezes the file; later payments start a new one.`
            : "No Vietnamese company bank account is set up, so nothing is routed to a bank file. Set BANK_FILE_SOURCE_ACCOUNT to the account you pay from (for example: VCB 0071000xxxxxx Ridgeline Vietnam)."
        }
      />
      {batches.length === 0 ? (
        <EmptyState title="No bank files yet" body="A VND payment to a vendor with a Vietnamese bank account appears here when it is paid by bank file." />
      ) : (
        <div className="space-y-6">
          {batches.map((b) => (
            <Panel key={b.id} title={`${b.currency} file of ${formatDateTime(b.createdAt)}`} aside={STATUS[b.status] ?? b.status} padded={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 hairline">
                <p className="num">
                  {b.lines.length} line{b.lines.length === 1 ? "" : "s"}, {formatMoney(b.totalMinor, b.currency)} from {b.sourceAccount}
                  {b.downloadedAt ? <span className="block text-xs text-ink-soft">Downloaded by {b.downloadedBy?.replace(/^user:/, "")} {formatDateTime(b.downloadedAt)}</span> : null}
                  {b.confirmedAt ? <span className="block text-xs text-ink-soft">Confirmed by {b.confirmedBy?.replace(/^user:/, "")} {formatDateTime(b.confirmedAt)}{b.bankRef ? `, bank reference ${b.bankRef}` : ""}</span> : null}
                </p>
                <div className="flex flex-wrap gap-2">
                  {canPay && b.status !== "confirmed" ? (
                    <a href={`/api/bank-files/${b.id}`} className="btn">
                      {b.status === "open" ? "Download and close the file" : "Download again"}
                    </a>
                  ) : null}
                  {canConfirm && b.status === "downloaded" ? <ConfirmBankFile batchId={b.id} count={b.lines.filter((l) => l.status === "queued").length} /> : null}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Vendor</th>
                      <th scope="col" className="hidden sm:table-cell">Account</th>
                      <th scope="col" className="hidden md:table-cell">Content</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="r">Amount</th>
                      {canConfirm && b.status === "downloaded" ? <th scope="col" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {b.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="font-medium">
                          <Link href={`/obligations/${l.obligationId}`} className="hover:underline">
                            {l.vendorName ?? l.beneficiaryName}
                          </Link>
                        </td>
                        <td className="num hidden text-ink-soft sm:table-cell">
                          {l.bankCode} {l.accountMasked}
                        </td>
                        <td className="hidden text-ink-soft md:table-cell">{l.memo}</td>
                        <td className={l.status === "returned" ? "text-attention" : l.status === "paid" ? "text-settled" : "text-ink-soft"}>{l.status}</td>
                        <td className="r num">{formatMoney(l.amountMinor, l.currency)}</td>
                        {canConfirm && b.status === "downloaded" ? <td className="r">{l.status === "queued" ? <ReturnLine lineId={l.id} /> : null}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
