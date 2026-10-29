import { runAs } from "@/lib/engine/requestContext";
import { warningFingerprint, type PolicyRuleResult } from "@/lib/domain/types";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness, getObligationDetail, listVendors } from "@/lib/queries";
import { toBaseMinor } from "@/lib/fx";
import { billBalance } from "@/lib/engine/bills";
import { bills as billsTable, obligations as obligationsTable } from "@/lib/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { getViewer } from "@/lib/viewer";
import { approvalGate, dualControlGap } from "@/lib/engine/orchestrator";
import { InvoiceDates } from "@/components/InvoiceDates";
import { getDb } from "@/lib/db";
import type { Rail } from "@/lib/domain/types";
import { countryName, evidenceKindLabel, formatDate, formatDateTime, formatMoney, formatMoneySymbol, railLabel, roleLabel, sourceTypeLabel, truncateMiddle } from "@/lib/format";
import { ActionBar } from "@/components/ActionBar";
import { VendorLinkButton } from "@/components/VendorLinkButton";
import { ObligationStageProvider, StageCheckLine } from "@/components/ObligationStage";
import { RouteCompare } from "@/components/RouteCompare";
import { RuleChecklist } from "@/components/RuleChecklist";
import { Timeline } from "@/components/Timeline";
import { CopyButton } from "@/components/CopyButton";
import { ScheduledReleases } from "@/components/ScheduledReleases";
import { KeyValue, Money, RailTag, StatePill } from "@/components/ui";
import { DecisionCard } from "@/components/DecisionCard";
import { allowedAction, checkLineCaption, decide, decidingLine, tidyDates, type Decision } from "@/components/decision-model";
import { Disclosure, ReferencePanel, TOUCH_INLINE, WorkingPanel } from "@/components/RequestPanels";
import { amountAsRead, correctionLine, RECORDED_LABEL, selectRecordedReading, summaryWithoutCount } from "@/components/agent-reading";
import { toolCallSentence } from "@/components/tool-call-sentence";
import { earlierPayments } from "@/lib/earlier-payment";

export const dynamic = "force-dynamic";
/** Tab title: "Phuong Transport, INV-2026-0152". */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const d = getObligationDetail((await params).id);
  if (!d) return { title: "Payment request not found" };
  const o = d.obligation;
  return { title: [o.vendorName ?? "Unknown vendor", o.sourceRef].filter(Boolean).join(", ") };
}

/** Pretty JSON for the raw view of a tool call; stored values are clipped, so fall back to the text. */
const raw = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

/** Mobile order (under 1024px): actions, evidence, then the rest. Desktop keeps the three columns. */
const ORDER = { exception: "order-1", actions: "order-2", evidence: "order-3", policy: "order-5", request: "order-6", agent: "order-7", route: "order-8", recipient: "order-9", bill: "order-10", settlement: "order-11", attempts: "order-12", approvals: "order-13", history: "order-14" } as const;
const ord = (k: keyof typeof ORDER) => `${ORDER[k]} lg:order-none`;

export default async function ObligationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = getObligationDetail(id);
  if (!d) notFound();
  const o = d.obligation;
  const hasAccounting = Boolean(d.accounting);
  const availableRails = d.quotes.filter((q) => q.available).map((q) => q.rail as Rail);
  const viewer = await getViewer();
  const bill = o.billId ? (() => {
    const b = getDb().select().from(billsTable).where(eq(billsTable.id, o.billId!)).get();
    return b ? { ...b, balance: billBalance(getDb(), b.id) } : null;
  })() : null;
  const base = getBusiness()?.baseCurrency ?? "USD";
  const baseMinor = o.amountMinor != null && o.currency && o.currency !== base ? toBaseMinor(o.amountMinor, o.currency, base) : null;
  const baseEquivalent = baseMinor != null ? formatMoneySymbol(baseMinor, base) : null;
  const perms = viewer ? { approve: viewer.can("approve"), pay: viewer.can("pay"), amend: viewer.can("amend"), resolveStuck: viewer.can("resolve_stuck"), reconcile: viewer.can("reconcile") } : undefined;
  const approveRefusal = viewer && o.state === "awaiting_approval" ? runAs(viewer.login, () => approvalGate(getDb(), o.id, viewer.actor.id)).refusal : null;
  const dualGap = o.state === "awaiting_approval" && o.amountMinor != null && o.currency ? dualControlGap(getDb(), o.businessId, baseMinor ?? (o.currency === base ? o.amountMinor : undefined)) : null;
  const vendorChoices = !o.vendorId && o.state === "blocked" ? listVendors().map((v) => ({ id: v.id, name: v.name })) : undefined;
  const earlier = earlierPayments([o.blockedReason, ...d.policyReasons, ...d.policyRules.map((r) => r.message)]);
  const selectedQuote = d.quotes.find((x) => x.rail === o.selectedRail && x.available) ?? null;
  const shownWarnings = d.policyRules.filter((r) => r.severity === "warn" && !r.passed).map((r) => warningFingerprint(r as PolicyRuleResult));
  const firstId = (o.blockedReason ?? "").match(/\b(obl_[a-z0-9]+)\b/i)?.[1];
  const caption = o.state === "blocked" && o.blockedReason ? checkLineCaption(o.blockedReason, earlier) : undefined;
  const decision: Decision = decide({
    state: o.state,
    amountMinor: o.amountMinor,
    currency: o.currency,
    blockedReason: o.blockedReason,
    policyReasons: d.policyReasons,
    rules: d.policyRules,
    selectedRail: o.selectedRail,
    quote: selectedQuote,
    availableRails,
    hasAccounting,
    settlement: d.settlement,
    releaseAt: o.releaseAt,
    earlier: firstId ? earlier.get(firstId) ?? null : null,
  });
  // An agent concern that only restates a failing amount check is the same reason twice: Policy keeps the check.
  const amountBlocked = d.policyRules.some((r) => !r.passed && r.severity === "block" && (r.ruleId === "amount_matches_evidence" || r.ruleId === "expected_amount"));
  const rules = d.policyRules.filter((r) => !(amountBlocked && r.ruleId === "ai_flag" && /differs from/i.test(r.message)));
  const ruleMessages = new Set(d.policyRules.map((r) => r.message));
  // The agent's concerns become policy warnings; list them here only if Policy does not already show them.
  const concernsElsewhere = d.aiFlags.length > 0 && d.aiFlags.every((f) => ruleMessages.has(f));
  const missingElsewhere = d.aiMissing.length > 0 && d.aiMissing.every((m) => ruleMessages.has(`Agent wants: ${m}`));
  const stated = new Set([decision.statedReason, ...(decision.alsoStated ?? [])]);
  const otherFailing = rules.filter((r) => !r.passed && !stated.has(r.message));
  const otherBlocks = otherFailing.filter((r) => r.severity === "block").length;
  const otherWarnings = otherFailing.length - otherBlocks;
  const perm = { approve: perms?.approve ?? true, pay: perms?.pay ?? true, amend: perms?.amend ?? true };
  const cardCarriesPrimary = Boolean(decision.action && allowedAction(decision.action, perm, approveRefusal));
  // "What you are deciding", as one line on the decision card.
  const deciding = ["awaiting_approval", "blocked", "needs_evidence"].includes(o.state)
    ? decidingLine({
        askMinor: o.amountMinor,
        currency: o.currency,
        evidence: d.evidence.filter((e) => !e.supersededBy),
        vendorName: d.vendor?.name ?? null,
        rail: o.selectedRail,
        verified: Boolean(d.vendor?.verifiedAt),
        alsoFound: { blocks: otherBlocks, warnings: otherWarnings },
      })
    : null;
  // A live Claude reading recorded for this demo request, replayed for display only. Policy never sees it.
  const asRead = amountAsRead(d.audit, { amountMinor: o.amountMinor, currency: o.currency });
  const newer = o.vendorId && o.sourceRef ? getDb().select({ id: obligationsTable.id }).from(obligationsTable).where(and(eq(obligationsTable.vendorId, o.vendorId), eq(obligationsTable.sourceRef, o.sourceRef), gt(obligationsTable.createdAt, o.createdAt))).get() : undefined;
  const recorded = selectRecordedReading({ engine: d.agentRun?.engine, vendorId: o.vendorId, sourceRef: o.sourceRef, readAmountMinor: asRead.amountMinor, readCurrency: asRead.currency, newestForReference: !newer });
  const corrected = correctionLine(d.audit, o.currency);
  const toolCtx = { vendorName: o.vendorName, sourceRef: o.sourceRef, evidenceCount: d.evidence.length, documentCount: d.attachments.length };
  const concernLine = concernsElsewhere || missingElsewhere ? `${[concernsElsewhere ? `${d.aiFlags.length} ${d.aiFlags.length === 1 ? "concern" : "concerns"}` : null, missingElsewhere ? `${d.aiMissing.length} ${d.aiMissing.length === 1 ? "missing record" : "missing records"}` : null].filter(Boolean).join(" and ")} raised. ${d.aiFlags.length + d.aiMissing.length === 1 ? "It is" : "They are"} listed under Policy.` : null;

  return (
    <ObligationStageProvider>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/obligations" className={`hover:text-ink ${TOUCH_INLINE}`}>
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

      <DecisionCard id={o.id} decision={decision} perms={perm} approveRefusal={approveRefusal} shownWarnings={shownWarnings} deciding={deciding} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_minmax(0,5fr)]">
        {/* Column 1: the request and its evidence. Under 1024px the columns dissolve so each panel can be ordered. */}
        <div className="contents lg:block lg:space-y-6">
          <WorkingPanel className={ord("request")} title="The request">
            <blockquote className="whitespace-pre-wrap leading-5">{o.rawInput}</blockquote>
            <dl className="num mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3 text-xs hairline">
              <dt className="text-ink-soft">Came in as</dt>
              <dd>{sourceTypeLabel(o.sourceType) || "a typed request"}</dd>
              <dt className="text-ink-soft">Created</dt>
              <dd>{formatDateTime(o.createdAt)}</dd>
              <InvoiceDates id={o.id} invoiceDate={o.invoiceDate} dueDate={o.dueDate} editable={Boolean(viewer?.can("amend")) && !["settled", "cancelled", "refunded"].includes(o.state)} />
              <dt className="text-ink-soft">Request id</dt>
              <dd className="flex items-center gap-1">
                {o.id}
                <CopyButton value={o.id} label="Copy request id" />
              </dd>
            </dl>
          </WorkingPanel>

          <WorkingPanel className={ord("evidence")} title="Evidence" aside={d.evidence.length ? `${d.evidence.filter((e) => !e.supersededBy).length} on file` : "none"}>
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
                      {e.provenance === "document" && e.attachmentId ? (() => { const a = d.attachments.find((x) => x.id === e.attachmentId); return a ? <span>, read from <a className={`link ${TOUCH_INLINE}`} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.name}</a> by {a.reader === "claude" ? "Claude" : "the text reader"}</span> : null; })() : null}
                    </p>
                    {e.excerpt ? <blockquote className="mt-1 border-l-2 pl-3 text-ink-soft hairline">{e.excerpt}</blockquote> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-soft">No evidence attached. Policy will not pay without a job sheet, invoice or contract.</p>
            )}
          </WorkingPanel>

          {d.vendor ? (
            <ReferencePanel className={ord("recipient")} title="Recipient" aside={<Link href={`/vendors/${d.vendor.id}`} className={`link ${TOUCH_INLINE}`}>Vendor page</Link>}>
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
            </ReferencePanel>
          ) : null}
        </div>

        {/* Column 2: agent reading, policy, route */}
        <div className="contents lg:block lg:space-y-6">
          <WorkingPanel className={ord("agent")} title="What the agent read" aside={!recorded && o.aiConfidence !== null ? <span className="num">confidence {o.aiConfidence}%</span> : null}>
            {recorded ? (
              <>
                <p className="mb-3 rounded border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-3 py-2 text-xs leading-4 text-ink-soft">{RECORDED_LABEL}</p>
                <p className="dense text-ink-soft">
                  Claude&apos;s confidence <span className="num">{recorded.confidence}%</span>
                </p>
                <p className="mt-1">{tidyDates(recorded.summary)}</p>
                {corrected ? <p className="num mt-1 font-medium text-ink-soft">{corrected}</p> : null}
                <ReadingList title="Concerns" tone="attention" items={recorded.flags.map(tidyDates)} />
                <ReadingList title="Wants before paying" tone="attention" items={recorded.missing.map(tidyDates)} />
                <ReadingList title="Notes" items={recorded.notes.map(tidyDates)} soft />
                <ToolCalls calls={recorded.toolCalls} ctx={toolCtx} title="What Claude checked" />
                <div className="mt-3 border-t pt-3 hairline">
                  <p className="text-xs text-ink-soft">This demo&apos;s own reading: rule-based reader (no model call)</p>
                  {o.aiSummary ? (
                    <Disclosure className="mt-1" summary="Show its reading">
                      <p className="text-ink-soft">{summaryWithoutCount(o.aiSummary)}</p>
                      {concernLine ? <p className="mt-1 text-ink-soft">{concernLine}</p> : null}
                      {d.aiFlags.length && !concernsElsewhere ? <ReadingList title="Concerns" tone="attention" items={d.aiFlags} /> : null}
                      {d.aiMissing.length && !missingElsewhere ? <ReadingList title="Wants before paying" tone="attention" items={d.aiMissing} /> : null}
                    </Disclosure>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                {o.aiSummary ? <p>{summaryWithoutCount(o.aiSummary)}</p> : <p className="text-ink-soft">The agent has not read this yet.</p>}
                {corrected ? <p className="num mt-1 text-ink-soft">{corrected}</p> : null}
                {d.aiFlags.length && !concernsElsewhere ? <ReadingList title="Concerns" tone="attention" items={d.aiFlags} /> : null}
                {d.agentRun?.notes.length ? <ReadingList title="Notes (do not affect payment)" items={d.agentRun.notes} soft /> : null}
                {d.aiMissing.length && !missingElsewhere ? <ReadingList title="Wants before paying" tone="attention" items={d.aiMissing} /> : null}
                {concernLine ? <p className="mt-3 text-ink-soft">{concernLine}</p> : null}
                {d.agentRun ? (
                  <div className="mt-3 border-t pt-3 hairline">
                    <p className="dense text-ink-soft">Read by</p>
                    <p className="mt-0.5">
                      {d.agentRun.engine === "claude" ? <>Claude <span className="num text-ink-soft">{d.agentRun.model}</span></> : <>Rule-based reader <span className="text-ink-soft">(no model call)</span></>}
                    </p>
                    {d.agentRun.toolCalls.length ? (
                      <ToolCalls calls={d.agentRun.toolCalls} ctx={toolCtx} title="What the agent checked" />
                    ) : (
                      <>
                        <p className="dense mt-2 text-ink-soft">What the agent checked</p>
                        <p className="mt-0.5 text-ink-soft">None. This reading used no tools{d.agentRun.engine === "rules" ? "" : " beyond the request and attached records"}.</p>
                      </>
                    )}
                  </div>
                ) : null}
              </>
            )}
            <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">The agent proposes. It has no authority to pay.</p>
          </WorkingPanel>

          <WorkingPanel className={ord("policy")} title="Policy">
            <RuleChecklist rules={rules} earlier={earlier} />
          </WorkingPanel>

          <WorkingPanel className={ord("route")} title="Route">
            <RouteCompare quotes={d.quotes} selectedRail={o.selectedRail} routeReason={o.routeReason} ready={o.state === "approved"} />
          </WorkingPanel>
        </div>

        {/* Column 3: actions, settlement, history */}
        <div className="contents lg:block lg:space-y-6">
          {d.payoutException ? (
            <section className={`panel ${ord("exception")}`} style={{ borderColor: "var(--attention)" }} aria-label="Payout needs attention">
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
            <WorkingPanel className={ord("exception")} title="Autopilot">
              <p className="text-ink-soft">Every check passed and this is within your caps, so the agent will send it when the cancel window ends. Policy runs once more at that moment.</p>
              <div className="mt-2">
                <ScheduledReleases compact rows={[{ id: o.id, vendorName: o.vendorName, amountText: formatMoney(o.amountMinor, o.currency), releaseAt: o.releaseAt }]} />
              </div>
            </WorkingPanel>
          ) : null}
          <WorkingPanel className={`${ord("actions")} pointer-coarse:[&_.btn]:h-11!`} label="Actions" title="Actions">
            {dualGap ? <p className="mb-2 rounded border border-attention bg-attention-soft px-3 py-2 text-xs text-ink" role="status">{dualGap}</p> : null}
            <ActionBar id={o.id} shownWarnings={shownWarnings} pendingKey={d.attempts.filter((a) => a.status === "unknown" || a.status === "pending").at(-1)?.idempotencyKey ?? null} state={o.state} amountMinor={o.amountMinor} currency={o.currency} blockedReason={o.blockedReason} selectedRail={o.selectedRail} availableRails={availableRails} hasAccounting={hasAccounting} perms={perms} approveRefusal={approveRefusal} vendorId={o.vendorId} billId={o.billId} vendorChoices={vendorChoices} primaryInCard={cardCarriesPrimary} />
            {o.vendorId && (["sent", "settled"].includes(o.state) ? !viewer || viewer.can("pay") : ["needs_evidence", "blocked", "awaiting_approval"].includes(o.state) && (!viewer || viewer.can("amend"))) ? (
              <div className="mt-4 border-t pt-3 hairline">
                <VendorLinkButton kind={["sent", "settled"].includes(o.state) ? "remittance" : "evidence"} obligationId={o.id} />
              </div>
            ) : null}
          </WorkingPanel>

          {bill ? (
            <ReferencePanel className={ord("bill")} title={`Part of ${bill.kind === "advance" ? "advance" : "invoice"} ${bill.reference}`} aside={o.paymentKind ?? "payment"}>
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
            </ReferencePanel>
          ) : null}
          {d.settlement ? (
            <ReferencePanel className={ord("settlement")} title="Settlement" aside={<RailTag rail={d.settlement.rail} />}>
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
            </ReferencePanel>
          ) : null}

          {d.attempts.length ? (
            <ReferencePanel className={ord("attempts")} title="Payment attempts" aside={`${d.attempts.length}`}>
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
            </ReferencePanel>
          ) : null}

          {d.approvals.length ? (
            <ReferencePanel className={ord("approvals")} title="Approvals">
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
            </ReferencePanel>
          ) : null}

          <ReferencePanel className={ord("history")} title="History">
            <Timeline entries={d.audit} />
          </ReferencePanel>
        </div>
      </div>
      {/* Room for the phone action bar, so it never covers the last panel. */}
      {decision.action ? <div className="h-14 lg:hidden" aria-hidden /> : null}
      <p className="sr-only">Amount {formatMoney(o.amountMinor, o.currency)}</p>
    </ObligationStageProvider>
  );
}

/** A short list in the agent panel: concerns, missing records or notes. */
function ReadingList({ title, items, tone, soft = false }: { title: string; items: string[]; tone?: "attention"; soft?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <p className={`dense ${tone === "attention" ? "text-attention" : "text-ink-soft"}`}>{title}</p>
      <ul className={`mt-1 list-disc space-y-1 pl-5 ${soft ? "text-ink-soft" : ""}`}>
        {items.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </div>
  );
}

/** The reader's tool calls as plain sentences, with the stored input and result behind "Show raw". */
function ToolCalls({ calls, ctx, title }: { calls: Array<{ name: string; input: string; resultPreview: string }>; ctx: Parameters<typeof toolCallSentence>[1]; title: string }) {
  return (
    <>
      <p className="dense mt-3 text-ink-soft">{title}</p>
      <ul className="mt-1 space-y-1">
        {calls.map((t, i) => (
          <li key={i} className="grid grid-cols-[12px_1fr] gap-x-2">
            <span aria-hidden className="mt-[7px] h-1.5 w-1.5 rounded-full bg-[color:var(--ink-soft)]" />
            <span>{toolCallSentence(t, ctx)}</span>
          </li>
        ))}
      </ul>
      <Disclosure className="mt-2" summary="Show raw">
        <ul className="space-y-1.5">
          {calls.map((t, i) => (
            <li key={i} className="rounded bg-[color:var(--paper)] px-2.5 py-1.5">
              <p className="num text-xs font-medium">{t.name}</p>
              <pre className="num mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all text-2xs leading-4 text-ink-soft" style={{ fontFamily: "inherit" }}>
                {t.input && t.input !== "{}" ? `input ${raw(t.input)}\n` : ""}
                {t.resultPreview ? `result ${raw(t.resultPreview)}` : ""}
              </pre>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-2xs text-ink-soft">Results are stored clipped to 200 characters.</p>
      </Disclosure>
    </>
  );
}
