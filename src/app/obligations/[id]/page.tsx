import Link from "next/link";
import { notFound } from "next/navigation";
import { getObligationDetail } from "@/lib/queries";
import type { Rail } from "@/lib/domain/types";
import { countryName, evidenceKindLabel, formatDate, formatDateTime, formatMoney, formatMoneySymbol, railLabel, roleLabel, sourceTypeLabel, stateLabel, truncateMiddle } from "@/lib/format";
import { ActionBar } from "@/components/ActionBar";
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
              {o.dueDate ? (
                <>
                  <dt className="text-ink-soft">Due</dt>
                  <dd>{formatDate(o.dueDate)}</dd>
                </>
              ) : null}
              <dt className="text-ink-soft">Obligation</dt>
              <dd className="flex items-center gap-1">
                {o.id}
                <CopyButton value={o.id} label="Copy obligation id" />
              </dd>
            </dl>
          </Panel>

          <Panel title="Evidence" aside={d.evidence.length ? `${d.evidence.length} on file` : "none"}>
            {d.evidence.length ? (
              <ul className="space-y-4">
                {d.evidence.map((e) => (
                  <li key={e.id}>
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
          {o.state === "approved" && o.releaseAt ? (
            <Panel title="Autopilot" aside="scheduled">
              <p className="text-ink-soft">Every check passed and this is within your caps, so the agent will send it when the cancel window ends. Policy runs once more at that moment.</p>
              <div className="mt-2">
                <ScheduledReleases compact rows={[{ id: o.id, vendorName: o.vendorName, amountText: formatMoney(o.amountMinor, o.currency), releaseAt: o.releaseAt }]} />
              </div>
            </Panel>
          ) : null}
          <Panel title="Actions" aside={stateLabel(o.state)}>
            <ActionBar id={o.id} state={o.state} amountMinor={o.amountMinor} currency={o.currency} blockedReason={o.blockedReason} selectedRail={o.selectedRail} availableRails={availableRails} hasAccounting={hasAccounting} />
          </Panel>

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
