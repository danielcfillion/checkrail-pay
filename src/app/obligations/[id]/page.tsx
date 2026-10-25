import { warningFingerprint, type PolicyRuleResult } from "@/lib/domain/types";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness, getObligationDetail, listVendors } from "@/lib/queries";
import { toBaseMinor } from "@/lib/fx";
import { billBalance } from "@/lib/engine/bills";
import { bills as billsTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getViewer } from "@/lib/viewer";
import { approvalGate, dualControlGap } from "@/lib/engine/orchestrator";
import { InvoiceDates } from "@/components/InvoiceDates";
import { getDb } from "@/lib/db";
import type { Rail } from "@/lib/domain/types";
import { countryName, evidenceKindLabel, formatDate, formatDateTime, formatMoney, formatMoneySymbol, railLabel, roleLabel, sourceTypeLabel, stateLabel, truncateMiddle } from "@/lib/format";
import { ActionBar } from "@/components/ActionBar";
import { VendorLinkButton } from "@/components/VendorLinkButton";
import { ObligationStageProvider, StageCheckLine } from "@/components/ObligationStage";
import { RouteCompare } from "@/components/RouteCompare";
import { RuleChecklist } from "@/components/RuleChecklist";
import { Timeline } from "@/components/Timeline";
import { CopyButton } from "@/components/CopyButton";
import { ScheduledReleases } from "@/components/ScheduledReleases";
import { KeyValue, Linkified, Money, Panel, RailTag, StatePill } from "@/components/ui";

export const dynamic = "force-dynamic";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export default async function ObligationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = getObligationDetail(id);
  if (!d) notFound();
  const o = d.obligation;
  const hasAccounting = Boolean(d.accounting);
  const availableRails = d.quotes.filter((q) => q.available).map((q) => q.rail as Rail);
  const caption = o.state === "blocked" && o.blockedReason ? shortReason(o.blockedReason) : undefined;
  const viewer = await getViewer();
  const bill = o.billId ? (() => {
    const b = getDb().select().from(billsTable).where(eq(billsTable.id, o.billId!)).get();
    return b ? { ...b, balance: billBalance(getDb(), b.id) } : null;
  })() : null;
  const base = getBusiness()?.baseCurrency ?? "USD";
  const baseMinor = o.amountMinor != null && o.currency && o.currency !== base ? toBaseMinor(o.amountMinor, o.currency, base) : null;
  const baseEquivalent = baseMinor != null ? formatMoneySymbol(baseMinor, base) : null;
  const perms = viewer ? { approve: viewer.can("approve"), pay: viewer.can("pay"), amend: viewer.can("amend"), resolveStuck: viewer.can("resolve_stuck") } : undefined;
  const approveRefusal = viewer && o.state === "awaiting_approval" ? approvalGate(getDb(), o.id, viewer.actor.id).refusal : null;
  const dualGap = o.state === "awaiting_approval" && o.amountMinor != null && o.currency ? dualControlGap(getDb(), o.businessId, baseMinor ?? (o.currency === base ? o.amountMinor : undefined)) : null;
  const vendorChoices = !o.vendorId && o.state === "blocked" ? listVendors().map((v) => ({ id: v.id, name: v.name })) : undefined;

  return (
    <ObligationStageProvider>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/obligations" className="hover:text-ink">
          Inbox
        </Link>
        <span aria-hidden> / </span>
        <span className="num">{o.sourceRef ?? "no reference"}</span>
      </nav>

      <header className="panel px-5 pb-5 pt-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {o.vendorId ? (
                <Link href={`/vendors/${o.vendorId}`} className="hover:underline">
                  {o.vendorName ?? "Unknown vendor"}
                </Link>
              ) : (
                o.vendorName ?? "Unknown vendor"
              )}
            </h1>
            <p className="num mt-0.5 text-ink-soft">
              {o.sourceRef ?? "No reference"}
              {o.vendorRole ? <span className="font-sans" style={{ fontVariantNumeric: "normal" }}>{`, ${roleLabel(o.vendorRole).toLowerCase()} in ${countryName(o.vendorCountry)}`}</span> : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="wide num text-3xl leading-10">{formatMoneySymbol(o.amountMinor, o.currency)}</p>
            {baseEquivalent ? <p className="num text-xs text-ink-soft">about {baseEquivalent} at reference rates</p> : null}
            <div className="mt-0.5 flex items-center justify-end gap-2">
              <StatePill state={o.state} />
              {o.selectedRail ? <RailTag rail={o.selectedRail} /> : null}
            </div>
          </div>
        </div>
        <div className="mt-5">
          <StageCheckLine state={o.state} hasAccounting={hasAccounting} caption={caption} />
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_minmax(0,5fr)]">
        {/* Column 1: the request and its evidence */}
        <div className="space-y-6">
          <Panel title="The request" aside={sourceTypeLabel(o.sourceType)}>
            <blockquote className="whitespace-pre-wrap leading-5">{o.rawInput}</blockquote>
            <dl className="num mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3 text-xs hairline">
              <dt className="text-ink-soft">Created</dt>
              <dd>{formatDateTime(o.createdAt)}</dd>
              <InvoiceDates id={o.id} invoiceDate={o.invoiceDate} dueDate={o.dueDate} editable={Boolean(viewer?.can("amend")) && !["settled", "cancelled", "refunded"].includes(o.state)} />
              <dt className="text-ink-soft">Obligation</dt>
              <dd className="flex items-center gap-1">
                {o.id}
                <CopyButton value={o.id} label="Copy obligation id" />
              </dd>
            </dl>
          </Panel>

          <Panel title="Evidence" aside={d.evidence.length ? `${d.evidence.filter((e) => !e.supersededBy).length} on file` : "none"}>
            {d.evidence.length ? (
              <ul className="space-y-4">
                {d.evidence.map((e) => (
                  <li key={e.id} className={e.supersededBy ? "opacity-60" : undefined}>
                    {e.supersededBy ? <p className="text-xs text-ink-soft">Replaced by the vendor&apos;s revised copy; kept for the record, no longer checked.</p> : null}
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="font-medium">{e.label}</p>
                      {e.amountMinor !== null ? <Money minor={e.amountMinor} currency={e.currency} className="shrink-0" /> : null}
                    </div>
                    <p className="dense text-ink-soft">
                      {evidenceKindLabel(e.kind)}
                      {e.reference ? <span className="num">, {e.reference}</span> : null}
                      {e.provenance === "operator" ? <span className="text-attention">, typed by operator</span> : null}
                      {e.provenance === "document" && e.attachmentId ? (() => { const a = d.attachments.find((x) => x.id === e.attachmentId); return a ? <span>, read from <a className="link" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.name}</a> by {a.reader === "claude" ? "Claude" : "the text reader"}</span> : null; })() : null}
                    </p>
                    {e.excerpt ? <blockquote className="mt-1 border-l-2 pl-3 text-ink-soft hairline">{e.excerpt}</blockquote> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-soft">No evidence attached. Policy will not pay without a job sheet, invoice or contract.</p>
            )}
          </Panel>

          {d.vendor ? (
            <Panel title="Recipient" aside={<Link href={`/vendors/${d.vendor.id}`} className="link">Vendor page</Link>}>
              <KeyValue
                rows={[
                  ["Name", d.vendor.name],
                  ["Country", countryName(d.vendor.country)],
                  ["PayPal", d.vendor.paypalEmail ?? "not on file"],
                  ["Stellar", d.vendor.stellarAccount ? <span className="num" title={d.vendor.stellarAccount}>{truncateMiddle(d.vendor.stellarAccount, 6)}</span> : "not on file"],
                  ["Bank", d.vendor.bankLabel ? `${d.vendor.bankLabel} (${d.vendor.bankCurrency})` : "not on file"],
                  ["Verified", d.vendor.verifiedAt ? formatDate(d.vendor.verifiedAt) : "not verified"],
                ]}
              />
            </Panel>
          ) : null}
        </div>

        {/* Column 2: agent reading, policy, route */}
        <div className="space-y-6">
          <Panel title="What the agent read" aside={o.aiConfidence !== null ? <span className="num">confidence {o.aiConfidence}%</span> : null}>
            {o.aiSummary ? <p>{o.aiSummary}</p> : <p className="text-ink-soft">The agent has not read this yet.</p>}
            {d.aiFlags.length ? (
              <div className="mt-3">
                <p className="dense text-attention">Concerns</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {d.aiFlags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {d.agentRun?.notes.length ? (
              <div className="mt-3">
                <p className="dense text-ink-soft">Notes (do not affect payment)</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">
                  {d.agentRun.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {d.aiMissing.length ? (
              <div className="mt-3">
                <p className="dense text-attention">Wants before paying</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {d.aiMissing.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {d.agentRun ? (
              <div className="mt-3 border-t pt-3 hairline">
                <p className="dense text-ink-soft">Read by</p>
                <p className="mt-0.5">
                  {d.agentRun.engine === "claude" ? <>Claude <span className="num text-ink-soft">{d.agentRun.model}</span></> : <>Rules extractor <span className="text-ink-soft">(no model call; set AI_MODE=live to use Claude)</span></>}
                </p>
                <p className="dense mt-2 text-ink-soft">Agent tool calls</p>
                {d.agentRun.toolCalls.length ? (
                  <ul className="mt-1 space-y-1.5">
                    {d.agentRun.toolCalls.map((t, i) => (
                      <li key={i} className="rounded bg-[color:var(--paper)] px-2.5 py-1.5">
                        <span className="num font-medium">{t.name}</span>
                        {t.input && t.input !== "{}" ? <span className="num ml-2 text-xs text-ink-soft">{clip(t.input, 90)}</span> : null}
                        {t.resultPreview ? <p className="num mt-0.5 text-xs text-ink-soft">{clip(t.resultPreview, 160)}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-ink-soft">None. This reading used no tools{d.agentRun.engine === "rules" ? "" : " beyond the request and attached records"}.</p>
                )}
              </div>
            ) : null}
            <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">The agent proposes. It has no authority to pay.</p>
          </Panel>

          {["awaiting_approval", "blocked", "needs_evidence"].includes(o.state) ? (
            <Panel title="What you are deciding" aside="at a glance">
              <ApprovalContext
                ask={formatMoney(o.amountMinor, o.currency)}
                evidence={d.evidence.filter((e) => e.amountMinor !== null && !e.supersededBy).map((e) => `${e.label}: ${formatMoney(e.amountMinor, e.currency)}`)}
                destination={d.vendor ? [d.vendor.name, o.selectedRail === "stellar" ? `Stellar ${truncateMiddle(d.vendor.stellarAccount, 6)}` : (o.selectedRail === "wise" || o.selectedRail === "bank_file") && d.vendor.bankLabel ? `bank account ${d.vendor.bankLabel}${d.vendor.accountHolder ? ` (${d.vendor.accountHolder})` : ""}` : d.vendor.paypalEmail ? `PayPal ${d.vendor.paypalEmail}` : "no payout method on file", d.vendor.verifiedAt ? `details verified ${formatDate(d.vendor.verifiedAt)}` : "details never verified"].join(", ") : "Unknown vendor"}
                route={(() => { const q = d.quotes.find((x) => x.rail === o.selectedRail && x.available); return q ? `${railLabel(q.rail)}, recipient gets ${formatMoney(q.receiveAmountMinor, q.receiveCurrency)}, fee ${formatMoney(q.feeMinor, q.sendCurrency)}` : "no route yet"; })()}
                why={o.blockedReason ?? d.policyReasons[0] ?? (o.state === "needs_evidence" ? "No evidence attached" : "")}
              />
            </Panel>
          ) : null}
          <Panel title="Policy" aside={o.policyDecision ? decisionText(o.policyDecision) : null}>
            <RuleChecklist rules={d.policyRules} />
            {o.blockedReason ? (
              <p className="mt-3 rounded bg-blocked-soft px-3 py-2 text-blocked">
                <span className="font-medium">Blocked: </span>
                <Linkified text={o.blockedReason} />
              </p>
            ) : d.policyReasons.length ? (
              <ul className="mt-3 space-y-1 rounded bg-attention-soft px-3 py-2 text-attention">
                {d.policyReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </Panel>

          <Panel title="Route">
            <RouteCompare quotes={d.quotes} selectedRail={o.selectedRail} routeReason={o.routeReason} />
          </Panel>
        </div>

        {/* Column 3: actions, settlement, history */}
        <div className="space-y-6">
          {d.payoutException ? (
            <section className="panel" style={{ borderColor: "var(--attention)" }} aria-label="Payout needs attention">
              <div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5 hairline">
                <h2 className="font-medium text-attention">Payout needs attention</h2>
                <span className="dense num text-ink-soft">{d.payoutException.externalStatus}</span>
              </div>
              <div className="p-4">
                <p>{d.payoutException.message}</p>
                <p className="mt-2 text-xs text-ink-soft">The money left the account and may still be claimed, so this payment will not be sent again. Fix it with the vendor, or cancel it with the provider.</p>
              </div>
            </section>
          ) : null}
          {o.state === "approved" && o.releaseAt ? (
            <Panel title="Autopilot" aside="scheduled">
              <p className="text-ink-soft">Every check passed and this is within your caps, so the agent will send it when the cancel window ends. Policy runs once more at that moment.</p>
              <div className="mt-2">
                <ScheduledReleases compact rows={[{ id: o.id, vendorName: o.vendorName, amountText: formatMoney(o.amountMinor, o.currency), releaseAt: o.releaseAt }]} />
              </div>
            </Panel>
          ) : null}
          <Panel title="Actions" aside={stateLabel(o.state)}>
            {dualGap ? <p className="mb-2 rounded border border-attention bg-attention-soft px-3 py-2 text-xs text-ink" role="status">{dualGap}</p> : null}
            <ActionBar id={o.id} shownWarnings={d.policyRules.filter((r) => r.severity === "warn" && !r.passed).map((r) => warningFingerprint(r as PolicyRuleResult))} pendingKey={d.attempts.filter((a) => a.status === "unknown" || a.status === "pending").at(-1)?.idempotencyKey ?? null} state={o.state} amountMinor={o.amountMinor} currency={o.currency} blockedReason={o.blockedReason} selectedRail={o.selectedRail} availableRails={availableRails} hasAccounting={hasAccounting} perms={perms} approveRefusal={approveRefusal} vendorId={o.vendorId} vendorChoices={vendorChoices} />
            {o.vendorId && (["sent", "settled"].includes(o.state) ? !viewer || viewer.can("pay") : ["needs_evidence", "blocked", "awaiting_approval"].includes(o.state) && (!viewer || viewer.can("amend"))) ? (
              <div className="mt-4 border-t pt-3 hairline">
                <VendorLinkButton kind={["sent", "settled"].includes(o.state) ? "remittance" : "evidence"} obligationId={o.id} />
              </div>
            ) : null}
          </Panel>

          {bill ? (
            <Panel title={`Part of ${bill.kind === "advance" ? "advance" : "invoice"} ${bill.reference}`} aside={o.paymentKind ?? "payment"}>
              <KeyValue
                rows={[
                  ["Bill total", formatMoney(bill.totalMinor, bill.currency)],
                  ["Paid", formatMoney(bill.balance.paidMinor, bill.currency)],
                  ["On its way or waiting", formatMoney(bill.balance.pendingMinor, bill.currency)],
                  ...(bill.balance.creditedMinor ? [["Credited", formatMoney(bill.balance.creditedMinor, bill.currency)] as [string, string]] : []),
                  ["Still open", formatMoney(bill.balance.openMinor, bill.currency)],
                ]}
              />
              {o.vendorId ? (
                <Link href={`/vendors/${o.vendorId}`} className="link mt-2 inline-block text-xs">
                  All bills for this vendor
                </Link>
              ) : null}
            </Panel>
          ) : null}
          {d.settlement ? (
            <Panel title="Settlement" aside={<RailTag rail={d.settlement.rail} />}>
              <KeyValue
                rows={[
                  ["Paid", <Money key="g" minor={d.settlement.grossMinor} currency={d.settlement.grossCurrency} />],
                  ["Fee", <Money key="f" minor={d.settlement.feeMinor} currency={d.settlement.grossCurrency} />],
                  ["Received", d.settlement.receivedMinor !== null ? <Money key="r" minor={d.settlement.receivedMinor} currency={d.settlement.receivedCurrency} /> : "pending"],
                  ["Rate", d.settlement.fxRate && d.settlement.receivedCurrency !== d.settlement.grossCurrency ? <span className="num">1 {d.settlement.grossCurrency} = {Number(d.settlement.fxRate).toLocaleString("en-US", { maximumFractionDigits: 4 })} {d.settlement.receivedCurrency}</span> : "no FX"],
                  ["Settled", formatDateTime(d.settlement.settledAt)],
                  [
                    d.settlement.rail === "stellar" ? "Transaction" : "Reference",
                    d.settlement.externalId ? (
                      <span className="flex items-center gap-1">
                        <span className="num" title={d.settlement.externalId}>
                          {truncateMiddle(d.settlement.externalId, 8)}
                        </span>
                        <CopyButton value={d.settlement.externalId} label="Copy external id" />
                      </span>
                    ) : (
                      "none"
                    ),
                  ],
                  ...(d.settlement.explorerUrl
                    ? [
                        [
                          "Explorer",
                          <a key="x" href={d.settlement.explorerUrl} className="link" target="_blank" rel="noreferrer">
                            View on Stellar explorer
                          </a>,
                        ] as [string, React.ReactNode],
                      ]
                    : d.settlement.rail === "stellar"
                      ? [["Explorer", <span key="x" className="text-ink-soft">Simulated, not on chain (mock rail)</span>] as [string, React.ReactNode]]
                      : []),
                  [
                    "Books",
                    d.accounting ? (
                      <span>
                        {d.accounting.status === "exported" || d.accounting.status === "synced" ? <span className="text-settled">{d.accounting.status}</span> : <span className="text-attention">{d.accounting.status}</span>} to {d.accounting.destination}
                        {d.accounting.externalRef ? <span className="num text-ink-soft"> ({d.accounting.externalRef})</span> : null}
                      </span>
                    ) : (
                      <span className="text-ink-soft">not yet recorded</span>
                    ),
                  ],
                ]}
              />
              <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">{d.settlement.note ?? "Delivery to the recipient is modelled from the quote, not observed."}</p>
            </Panel>
          ) : null}

          {d.attempts.length ? (
            <Panel title="Payment attempts" aside={`${d.attempts.length}`}>
              <ul className="space-y-2">
                {d.attempts.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p>
                        <span className="font-medium">{railLabel(a.rail)}</span> <span className={a.status === "failed" ? "text-blocked" : a.status === "confirmed" ? "text-settled" : "text-ink-soft"}>{a.status}</span>
                        <span className="dense ml-1 text-ink-soft">{a.mode}</span>
                      </p>
                      {a.errorMessage ? <p className="text-xs text-blocked">{a.errorMessage}</p> : null}
                    </div>
                    <span className="num shrink-0 text-xs text-ink-soft" title={a.externalId ?? undefined}>
                      {truncateMiddle(a.externalId, 6) || "no id"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {d.approvals.length ? (
            <Panel title="Approvals">
              <ul className="space-y-2">
                {d.approvals.map((a) => (
                  <li key={a.id}>
                    <p>
                      <span className="font-medium">{a.decision === "approved" ? "Approved" : "Rejected"}</span> <span className="text-ink-soft">by {a.actor.replace(/^user:/, "").replace(/^\w/, (c) => c.toUpperCase())}</span>
                    </p>
                    {a.note ? <p className="text-xs text-ink-soft">{a.note}</p> : null}
                    <p className="num text-xs text-ink-soft">{formatDateTime(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel title="History" aside={`${d.audit.length} entries`}>
            <Timeline entries={d.audit} />
          </Panel>
        </div>
      </div>
      <p className="sr-only">Amount {formatMoney(o.amountMinor, o.currency)}</p>
    </ObligationStageProvider>
  );
}

function decisionText(d: string): string {
  switch (d) {
    case "auto_execute":
      return "cleared to pay";
    case "require_approval":
      return "approval required";
    case "block":
      return "blocked";
    case "hold":
      return "held";
    default:
      return d.replace(/_/g, " ");
  }
}

/** Trims a blocked reason to a short caption for the check line. */
function shortReason(reason: string): string {
  if (/already used/.test(reason)) return "duplicate reference";
  const m = reason.match(/says ([A-Z]{3} [\d,]+\.\d{2})/);
  if (m) return `evidence says ${m[1]}`;
  return reason.length > 48 ? reason.slice(0, 45) + "…" : reason;
}

/** The four facts an approver needs side by side: what was asked, what the evidence says, where the money goes, and what it costs. */
function ApprovalContext({ ask, evidence, destination, route, why }: { ask: string; evidence: string[]; destination: string; route: string; why: string }) {
  return (
    <div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="dense text-ink-soft">Asked for</dt>
        <dd className="num font-medium">{ask}</dd>
        <dt className="dense text-ink-soft">Evidence says</dt>
        <dd className="num">{evidence.length ? evidence.join("; ") : <span className="text-attention">nothing with an amount</span>}</dd>
        <dt className="dense text-ink-soft">Goes to</dt>
        <dd>{destination}</dd>
        <dt className="dense text-ink-soft">Route</dt>
        <dd>{route}</dd>
      </dl>
      {why ? <p className="mt-3 border-t pt-3 text-attention hairline">{why}</p> : null}
    </div>
  );
}
