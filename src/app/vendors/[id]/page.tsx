import { runAs } from "@/lib/engine/requestContext";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness, getVendorDetail, listSettlements } from "@/lib/queries";
import { toBaseOrZero } from "@/lib/fx";
import { countryName, formatDate, formatMoneySymbol, railLabel, roleLabel, truncateMiddle } from "@/lib/format";
import { ObligationTable } from "@/components/ObligationList";
import { EmptyState, KeyValue, Panel, RailTag } from "@/components/ui";
import { getDb } from "@/lib/db";
import { getViewer } from "@/lib/viewer";
import { changesFor, describeChange, verifyBarrier, VERIFY_METHOD_LABEL, type VerifyMethod } from "@/lib/engine/vendors";
import { BlockToggle, InviteLink, PendingChange } from "@/components/VendorControls";
import { BillsPanel } from "@/components/BillsPanel";
import { RatesPanel } from "@/components/RatesPanel";
import { ratesFor } from "@/lib/engine/rates";
import { TAX_FORM_LABEL } from "@/lib/engine/taxes";
import { vendorBills } from "@/lib/engine/bills";
import { obligations as obligationsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const d = getVendorDetail((await params).id);
  return { title: d ? d.vendor.name : "Vendor not found" };
}

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = getVendorDetail(id);
  if (!d) notFound();
  const v = d.vendor;
  const settlements = listSettlements().filter((s) => s.obligation.vendorId === v.id);
  const base = getBusiness()?.baseCurrency ?? "USD";
  const paid = settlements.reduce((a, s) => a + toBaseOrZero(s.grossMinor, s.grossCurrency, base), 0);
  const fees = settlements.reduce((a, s) => a + toBaseOrZero(s.feeMinor, s.grossCurrency, base), 0);
  const open = d.obligations.filter((o) => !["settled", "cancelled", "refunded"].includes(o.state));
  const viewer = await getViewer();
  const db = getDb();
  const history = changesFor(db, v.id);
  const pendingRows = history.filter((c) => c.status === "pending");
  const canVerify = !viewer || viewer.can("verify_vendor");
  const canEdit = !viewer || viewer.can("edit_vendor");
  const vb = vendorBills(db, v.id);
  const pays = db.select({ id: obligationsTable.id, state: obligationsTable.state, amountMinor: obligationsTable.amountMinor, paymentKind: obligationsTable.paymentKind, billId: obligationsTable.billId }).from(obligationsTable).where(eq(obligationsTable.vendorId, v.id)).all();
  const billRows = vb.bills.map((b) => ({ id: b.id, kind: b.kind, reference: b.reference, totalMinor: b.totalMinor, currency: b.currency, dueDate: b.dueDate, status: b.status, note: b.note, balance: b.balance, payments: pays.filter((p) => p.billId === b.id && p.state !== "cancelled") }));

  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/vendors" className="tap inline-block hover:text-ink">
          Vendors
        </Link>
        <span aria-hidden> / </span>
        {v.name}
      </nav>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {v.name}
            {v.status === "blocked" ? <span className="ml-3 align-middle text-sm font-medium text-attention">blocked</span> : null}
          </h1>
          <p className="mt-1 text-ink-soft">
            {roleLabel(v.role)} in {countryName(v.country)}
            {v.preferredRail ? `, prefers ${railLabel(v.preferredRail)}` : ""}
          </p>
        </div>
        <dl className="flex gap-8 text-right">
          <div>
            <dt className="dense text-ink-soft">Paid to date</dt>
            <dd className="wide num text-xl">{formatMoneySymbol(paid, base)}</dd>
          </div>
          <div>
            <dt className="dense text-ink-soft">Fees</dt>
            <dd className="wide num text-xl">{formatMoneySymbol(fees, base)}</dd>
          </div>
          <div>
            <dt className="dense text-ink-soft">Open</dt>
            <dd className="wide num text-xl">{open.length}</dd>
          </div>
        </dl>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-6">
          {pendingRows.length ? (
            <Panel title="Waiting for verification" aside="payments use the details on file until then">
              {pendingRows.map((c) => (
                <PendingChange key={c.id} c={describeChange(db, c)} canVerify={canVerify} mine={viewer ? runAs(viewer.login, () => verifyBarrier(db, v.businessId, viewer.actor.id, c)) : null} />
              ))}
            </Panel>
          ) : null}
          <Panel title="Payout details" aside={v.verifiedAt ? <span className="text-settled">verified {formatDate(v.verifiedAt)}</span> : <span className="text-attention">not verified</span>}>
            <KeyValue
              rows={[
                ["PayPal", v.paypalEmail ?? <span className="text-ink-soft">not on file</span>],
                ["Stellar", v.stellarAccount ? <span className="num" title={v.stellarAccount}>{truncateMiddle(v.stellarAccount, 8)}</span> : <span className="text-ink-soft">not on file</span>],
                ["Bank", v.bankLabel ? `${v.bankLabel}, ${v.bankCurrency} in ${countryName(v.bankCountry)}` : <span className="text-ink-soft">not on file</span>],
                ["Email", v.email ?? <span className="text-ink-soft">none</span>],
                ["Phone", v.phone ? <span className="num">{v.phone}</span> : <span className="text-attention">none: add one to call back about bank changes</span>],
                ["Tax ID", v.taxId ? <span className="num">{v.taxId}</span> : <span className="text-ink-soft">none</span>],
                ["Terms", v.paymentTermsDays != null ? `${v.paymentTermsDays} days unless the invoice says otherwise` : <span className="text-ink-soft">from each invoice</span>],
                ["Preferred rail", v.preferredRail ? <RailTag rail={v.preferredRail} /> : <span className="text-ink-soft">let the router choose</span>],
                ["Tax", v.taxForm && v.taxForm !== "none" ? `${v.taxType ?? "payee"}, ${TAX_FORM_LABEL[v.taxForm] ?? v.taxForm} on file${v.taxFormAt ? ` since ${formatDate(v.taxFormAt)}` : ""}${v.withholdingBps ? `, EWT ${v.withholdingBps / 100}%` : ""}` : <span className="text-attention">no tax form on file</span>],
              ]}
            />
            <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">
              {v.verifiedAt
                ? `Checked by ${(v.verifiedBy ?? "the seed").replace(/^user:/, "")}${v.verificationMethod && v.verificationMethod in VERIFY_METHOD_LABEL ? `: ${VERIFY_METHOD_LABEL[v.verificationMethod as VerifyMethod].toLowerCase()}` : ""}. `
                : "Not paid until someone verifies these. "}
              New details are a request that someone other than the requester verifies; until then the details above stay in use.
            </p>
            {canEdit || canVerify ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t pt-3 hairline">
                {canEdit || canVerify ? (
                  <Link href={`/vendors/${v.id}/edit`} className="btn btn-sm">
                    {canEdit ? "Edit" : "Tax, country and phone"}
                  </Link>
                ) : null}
                {canVerify ? <BlockToggle vendorId={v.id} status={v.status} /> : null}
              </div>
            ) : null}
            {!viewer || viewer.can("invite_vendor") ? (
              <div className="mt-3 border-t pt-3 hairline">
                <InviteLink vendorId={v.id} />
              </div>
            ) : null}
          </Panel>
          <Panel title="Rate card" aside={<Link href="/departures" className="link">Departures</Link>}>
            <RatesPanel vendorId={v.id} rows={ratesFor(db, v.id)} canSet={!viewer || viewer.can("verify_vendor")} defaultCurrency="USD" />
          </Panel>
          {history.some((c) => c.status !== "pending") ? (
            <Panel title="Detail changes">
              <ul className="space-y-1 text-sm">
                {history
                  .filter((c) => c.status !== "pending")
                  .map((c) => (
                    <li key={c.id}>
                      <span className="num text-ink-soft">{formatDate(c.decidedAt ?? c.createdAt)}</span> {c.kind === "payout" ? "Payout change" : c.kind === "create" ? "Onboarded" : "First details"} {c.status}
                      {c.decidedBy ? ` by ${c.decidedBy.replace(/^user:/, "")}` : ""}
                      {c.method && c.method in VERIFY_METHOD_LABEL ? ` (${VERIFY_METHOD_LABEL[c.method as VerifyMethod].toLowerCase()})` : ""}
                    </li>
                  ))}
              </ul>
            </Panel>
          ) : null}
          {v.notes ? (
            <Panel title="Notes">
              <p>{v.notes}</p>
            </Panel>
          ) : null}
        </div>
        <div className="space-y-6">
          <Panel title="Bills and balance" aside="deposits, credits, advances">
            <BillsPanel vendorId={v.id} rows={billRows} position={vb.position} canIngest={!viewer || viewer.can("ingest")} canAmend={!viewer || viewer.can("amend")} defaultCurrency={v.bankCurrency && ["USD", "VND", "PHP", "THB"].includes(v.bankCurrency) && v.bankAccountEnc ? v.bankCurrency : "USD"} />
          </Panel>
          <div>
          <h2 className="mb-3 font-medium">Payment requests</h2>
          {d.obligations.length ? <ObligationTable rows={d.obligations} vendorPage /> : <EmptyState title="Nothing yet for this vendor" body="Requests appear here once one names this vendor." />}
          </div>
        </div>
      </div>
    </>
  );
}
