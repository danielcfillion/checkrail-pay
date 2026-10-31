import Link from "next/link";
import type { ReactNode } from "react";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { SUPPORTED_CURRENCIES } from "@/lib/domain/money";
import { pendingChanges } from "@/lib/engine/vendors";
import { listImports } from "@/lib/onboarding/imports";
import { dataSources } from "@/lib/onboarding/sources";
import { formatMoney, humaniseActor, pluralise } from "@/lib/format";
import { EmptyState, PageHeader, Panel, RelativeTime } from "@/components/ui";
import { Stepper } from "@/components/onboarding/Stepper";
import { BankImport } from "@/components/onboarding/BankImport";
import { shortDate } from "@/components/onboarding/import-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bring in your data" };

export default async function BringInYourDataPage() {
  const viewer = await getViewer();
  const biz = getBusiness();
  if (!biz) {
    return (
      <>
        <Stepper current={1} />
        <PageHeader title="Bring in your data" />
        <EmptyState title="No business configured" body="Reset the demo from the overview to load Ridgeline Expeditions." />
      </>
    );
  }
  const db = getDb();
  const src = dataSources(db, biz.id);
  const changes = pendingChanges(db, biz.id).length;
  const waiting = src.suppliers.unverified + changes;
  const imports = listImports(db, biz.id, 20);
  const canIngest = !viewer || viewer.can("ingest");

  return (
    <>
      <Stepper current={1} />
      <PageHeader title="Bring in your data" lede="Nothing you bring in can pay anyone. It is the history Checkrail learns your business from, and it takes about an hour." />

      <ul className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Where your history comes from">
        <Source status={<Status tone="settled">Connected</Status>} title="PayPal history">
          Read from PayPal Transaction Search before every payment, so there is nothing to upload. {pluralise(src.paypal.suppliers, "supplier")} paid on PayPal.
        </Source>
        <Source
          status={waiting ? <Status tone="attention">{waiting} need{waiting === 1 ? "s" : ""} a second person</Status> : src.suppliers.total ? <Status tone="settled">All verified</Status> : <Status>None yet</Status>}
          title="Suppliers"
          link={<Link href="/vendors" className="link">Open vendors</Link>}
        >
          {pluralise(src.suppliers.total, "supplier")} from a CSV or Xero contacts, {src.suppliers.verified} verified.{" "}
          {changes ? `${pluralise(changes, "change")} to payout details ${changes === 1 ? "waits" : "wait"} for a second person to check.` : "New payout details always wait for a second person."}
        </Source>
        <Source status={src.bank.imports ? <Status tone="settled">{pluralise(src.bank.imports, "re-check")}</Status> : <Status>Below</Status>} title="Past bank payments" link={<a href="#bank-file" className="link">Upload below</a>}>
          {src.bank.latest ? (
            <>
              Latest: <span className="mono text-[13px]">{src.bank.latest.fileName}</span>, {pluralise(src.bank.latest.payments, "payment")}.
            </>
          ) : (
            "Your bank's CSV export. Checkrail re-checks the last 90 days."
          )}
          {src.bank.savedLayouts ? ` The next export from the same bank maps itself.` : ""}
        </Source>
        <Source
          status={src.rates.rateCards ? <Status tone="settled">{pluralise(src.rates.rateCards, "rate card")}</Status> : <Status tone="attention">None yet</Status>}
          title="Rate cards and departures"
          link={
            <span className="flex flex-wrap gap-x-3">
              <Link href="/departures" className="link">
                Departures and rates
              </Link>
              <Link href="/vendors" className="link">
                Rate cards by supplier
              </Link>
            </span>
          }
        >
          {pluralise(src.rates.suppliersWithRates, "supplier")} with a rate card, {pluralise(src.rates.departures, "departure")}. Invoices are checked against them.
        </Source>
      </ul>

      <div id="bank-file" className="scroll-mt-6">
        <BankImport canIngest={canIngest} currencies={SUPPORTED_CURRENCIES} baseCurrency={biz.baseCurrency} />
      </div>

      <div className="mt-8">
        <Panel title="Past re-checks" aside={imports.length ? pluralise(imports.length, "file") : undefined} padded={false}>
          {imports.length ? (
            <div className="overflow-x-auto">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col" className="max-md:hidden">
                      Brought in
                    </th>
                    <th scope="col">Period</th>
                    <th scope="col" className="r">
                      Payments
                    </th>
                    <th scope="col" className="r">
                      Would have been stopped
                    </th>
                    <th scope="col" className="r max-sm:hidden">
                      Held
                    </th>
                    <th scope="col" className="r">
                      <span className="sr-only">Calls</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((i) => (
                    <tr key={i.id}>
                      <td className="max-w-[260px]">
                        <span className="mono block truncate text-[13px]" title={i.fileName}>
                          {i.fileName}
                        </span>
                        {i.status === "failed" ? <span className="dense text-blocked">Did not finish: {i.error}</span> : null}
                      </td>
                      <td className="whitespace-nowrap text-ink-soft max-md:hidden">
                        <RelativeTime iso={i.createdAt} /> by {humaniseActor(i.createdBy)}
                      </td>
                      <td className="whitespace-nowrap text-ink-soft">{i.periodFrom ? `${shortDate(i.periodFrom)} to ${shortDate(i.periodTo)}` : "none"}</td>
                      <td className="r num">{i.payments}</td>
                      <td className="r num whitespace-nowrap">{i.status === "checked" ? formatMoney(i.wouldHaveBlockedMinor, i.currency) : ""}</td>
                      <td className="r num max-sm:hidden">{i.heldCount}</td>
                      <td className="r whitespace-nowrap">
                        {i.status === "checked" ? (
                          <Link href={`/onboarding/calibrate?import=${encodeURIComponent(i.id)}`} className="link">
                            Check calls
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 pb-6 pt-2 text-ink-soft">No bank file re-checked yet. The first one appears here.</p>
          )}
        </Panel>
      </div>
    </>
  );
}

function Source({ status, title, children, link }: { status: ReactNode; title: string; children: ReactNode; link?: ReactNode }) {
  return (
    <li className="panel flex min-w-0 flex-col px-5 py-4">
      {status}
      <h2 className="mt-1.5 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-ink-soft">{children}</p>
      {link ? <div className="mt-auto pt-3">{link}</div> : null}
    </li>
  );
}

function Status({ tone, children }: { tone?: "settled" | "attention"; children: ReactNode }) {
  const colour = tone === "settled" ? "text-settled" : tone === "attention" ? "text-attention" : "text-ink-soft";
  return (
    <p className={`dense inline-flex items-center gap-1.5 font-semibold ${colour}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        {tone === "settled" ? <path d="M3.25 6.25l1.9 1.9L8.9 4.2" /> : tone === "attention" ? (
          <>
            <circle cx="6" cy="6" r="4.4" strokeWidth="1.3" />
            <path d="M6 3.5V6l1.6 1.2" />
          </>
        ) : (
          <path d="M3.5 6h5" />
        )}
      </svg>
      {children}
    </p>
  );
}
