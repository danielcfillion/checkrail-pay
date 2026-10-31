import Link from "next/link";
import { headers } from "next/headers";
import { agentSummary, recentAgentChecks } from "@/lib/agent/activity";
import { config } from "@/lib/config";
import { realMoneyEnv } from "@/lib/basicAuth";
import { formatMoney, pluralise } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { EmptyState, PageHeader, Panel, RelativeTime, TonePill } from "@/components/ui";
import { BudgetBar, OfferPill, ProvenanceList, offerOutcome } from "@/components/AgentFutures";
import { getDb } from "@/lib/db";
import { getBusiness, listVendors } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { SUPPORTED_CURRENCIES } from "@/lib/domain/money";
import { listMandates, mandatePublicKey, PURPOSE_LABEL } from "@/lib/agent/mandates";
import { listOffers, offerLine } from "@/lib/agent/offers";
import { IssueMandateForm, RevokeMandateButton } from "./MandateControls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

const TRUST: Record<string, string> = { check: "Checks only", request: "Checks and requests", attest: "System of record", supplier: "A supplier's own agent" };
const trustOf = (scopes: string[]) => (scopes.includes("supplier") ? TRUST.supplier : scopes.includes("attest") ? TRUST.attest : scopes.includes("request") ? TRUST.request : scopes.length ? TRUST.check : "Local, on this machine");
const MANDATE_STATUS: Record<string, { tone: "settled" | "muted" | "blocked" | "attention"; label: string }> = { active: { tone: "settled", label: "Active" }, expired: { tone: "muted", label: "Expired" }, revoked: { tone: "blocked", label: "Revoked" }, not_yet_valid: { tone: "attention", label: "Not yet valid" } };
const ROLE_PLURAL: Record<string, string> = { guide: "guides", driver: "drivers", homestay: "homestays", hotel: "hotels", creator: "creators" };

function Verdict({ verdict }: { verdict: string }) {
  if (verdict === "block") return <TonePill tone="blocked">Blocked</TonePill>;
  if (verdict === "refused") return <TonePill tone="blocked">Refused</TonePill>;
  if (verdict === "pay") return <TonePill tone="settled">Clear</TonePill>;
  return <TonePill tone="attention">A person looks</TonePill>;
}

const FRESH_MS = 12_000;

export default async function AgentsPage() {
  const s = agentSummary();
  const recent = recentAgentChecks(undefined, 50);
  const now = Date.now();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/api/mcp`;
  const open = process.env.CHECKRAIL_AGENT_DEMO_OPEN === "1" && config.rails.mode === "mock" && !realMoneyEnv(process.env);
  const claudeCode = `claude mcp add --transport http checkrail ${url} --header "Authorization: Bearer <agent key>"`;
  const db = getDb();
  const biz = getBusiness(db);
  const viewer = await getViewer();
  const isOwner = Boolean(viewer?.can("settings"));
  const mandates = biz ? listMandates(db, biz.id) : [];
  const offers = biz ? listOffers(db, biz.id) : [];
  const suppliers = biz ? listVendors().map((v) => ({ id: v.id, name: v.name, role: v.role })) : [];
  let signer: { stellar: string; base64url: string } | null = null;
  try {
    signer = mandatePublicKey();
  } catch {
    signer = null; // no data key where one is required: mandates cannot be signed here
  }
  const desktop = `{ "mcpServers": { "checkrail": {
  "command": "npm",
  "args": ["--prefix", "/path/to/checkrail-pay", "run", "-s", "mcp"],
  "env": { "CHECKRAIL_AGENT_NAME": "claude-desktop" } } } }`;

  return (
    <>
      <AutoRefresh seconds={4} />
      <PageHeader
        title="Agents"
        lede="PayPal moves money for people. Next it moves money for agents, and agents need a check rail. Outside agents ask Checkrail before they pay a supplier: a check judges a copy of your books and changes nothing, and a request goes to your inbox, where your rules and your autonomy setting decide. No agent can approve or send a payment."
      />

      {s.keysMalformed ? <p className="mb-4 rounded border hairline bg-sheet p-3 text-sm text-blocked">CHECKRAIL_AGENT_KEYS is malformed, so every agent call is refused. The format is name:secret:check, name:secret:check+request or name:secret:check+request+attest, comma separated.</p> : null}

      <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Figure label="Checks, 7 days" value={String(s.totals.checks)} note="questions agents asked before paying" />
        <Figure label="Blocked" value={String(s.totals.blocked)} note={s.totals.blocked ? "agents were told not to pay" : "nothing blocked"} tone={s.totals.blocked ? "blocked" : undefined} />
        <Figure label="A person looks" value={String(s.totals.held)} note="held for someone to decide" tone={s.totals.held ? "attention" : undefined} />
        <Figure label="Clear" value={String(s.totals.cleared)} note="passed every rule within your limits" tone={s.totals.cleared ? "settled" : undefined} />
        <Figure label="Requests" value={String(s.totals.requests)} note="put in your inbox by agents" />
      </dl>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid min-w-0 gap-6">
          <Panel title="Recent questions" padded={false}>
            {recent.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No agent has asked yet" body="Connect an agent with the details on the right, then ask it to pay a supplier. Every check and request appears here." />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col" className="hidden sm:table-cell">
                        When
                      </th>
                      <th scope="col">Agent</th>
                      <th scope="col">Payee</th>
                      <th scope="col" className="r hidden sm:table-cell">
                        Amount
                      </th>
                      <th scope="col">Answer</th>
                      <th scope="col" className="hidden md:table-cell">
                        Why
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((c) => (
                      // A question asked in the last few seconds slides in, so a live agent call is visible as it lands.
                      <tr key={c.id} className={now - Date.parse(c.createdAt) < FRESH_MS ? "row-new" : undefined}>
                        <td className="hidden whitespace-nowrap text-ink-soft sm:table-cell">
                          <RelativeTime iso={c.createdAt} />
                        </td>
                        <td>
                          <span className="font-medium">{c.agent}</span>
                          <span className="block text-xs text-ink-soft">
                            {c.tool === "request_payment" ? "Request" : "Check"}
                            <span className="sm:hidden">
                              , <RelativeTime iso={c.createdAt} />
                            </span>
                          </span>
                        </td>
                        <td>
                          {c.obligationId ? (
                            <Link href={`/obligations/${c.obligationId}`} className="hover:underline">
                              {c.payee}
                            </Link>
                          ) : (
                            c.payee
                          )}
                          {c.reference ? <span className="num block text-xs text-ink-soft">{c.reference}</span> : null}
                          {c.amountMinor != null && c.currency ? <span className="num block text-xs sm:hidden">{formatMoney(c.amountMinor, c.currency, { code: true })}</span> : null}
                        </td>
                        <td className="r num hidden whitespace-nowrap sm:table-cell">{c.amountMinor != null && c.currency ? formatMoney(c.amountMinor, c.currency, { code: true }) : ""}</td>
                        <td>
                          <Verdict verdict={c.verdict} />
                        </td>
                        <td className="hidden max-w-[420px] text-sm md:table-cell">
                          {c.summary}
                          <ProvenanceList lines={c.provenance} className="mt-2" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Counter-offers to suppliers' agents" aside={offers.length ? `${offers.length} recent` : undefined} padded={false}>
            {offers.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-ink-soft">When a supplier&apos;s own agent asks for more than your records support, Checkrail offers the supported amount instead. Offers and what became of them appear here.</p>
            ) : (
              <ul className="divide-y hairline">
                {offers.map((o) => (
                  <li key={o.id} className="grid gap-1 px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p>
                        <span className="font-medium">{o.vendorName}</span> <span className="text-ink-soft">through {o.agent}</span>
                        {o.reference ? <span className="num text-ink-soft">, {o.reference}</span> : null}
                      </p>
                      <OfferPill status={o.status} />
                    </div>
                    <p className="num">{offerLine(o)}</p>
                    <p className="text-xs text-ink-soft">Based on {o.basis}.</p>
                    <p className="text-ink-soft">
                      {offerOutcome(o)}{" "}
                      {o.resultObligationId ? (
                        <Link href={`/obligations/${o.resultObligationId}`} className="link">
                          Open the request
                        </Link>
                      ) : o.obligationId ? (
                        <Link href={`/obligations/${o.obligationId}`} className="link">
                          Open the request it answered
                        </Link>
                      ) : null}
                    </p>
                    {o.disputeReason ? <blockquote className="border-l-2 pl-3 text-ink-soft hairline">Their reason (its own say-so): {o.disputeReason}</blockquote> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Agents" padded={false}>
            {s.agents.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No agent keys set" body="Add one to CHECKRAIL_AGENT_KEYS, or run the local server on this machine (see Connect an agent)." />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Trust</th>
                      <th scope="col" className="hidden md:table-cell">
                        Last asked
                      </th>
                      <th scope="col" className="r">
                        Checks
                      </th>
                      <th scope="col" className="r">
                        Blocked
                      </th>
                      <th scope="col" className="r">
                        Requests
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.agents.map((a) => (
                      <tr key={a.name}>
                        <td className="font-medium">{a.name}</td>
                        <td className="text-sm">{trustOf(a.scopes)}</td>
                        <td className="hidden whitespace-nowrap text-ink-soft md:table-cell">{a.lastSeen ? <RelativeTime iso={a.lastSeen} /> : "never"}</td>
                        <td className="r num">{a.checks}</td>
                        <td className={`r num ${a.blocked ? "text-blocked" : ""}`}>{a.blocked}</td>
                        <td className="r num">{a.requests}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="grid min-w-0 content-start gap-6">
          <Panel title="Spending mandates" aside={mandates.some((m) => m.status === "active") ? `${mandates.filter((m) => m.status === "active").length} active` : undefined}>
            <div className="grid min-w-0 gap-4 text-sm">
              <p className="text-ink-soft">A signed, expiring allowance for one agent: who it may ask to pay, how much each time and in all. It narrows what the agent may request; your rules and approval still decide every payment.</p>
              {mandates.length === 0 ? <p className="text-ink-soft">No mandates yet.</p> : null}
              {mandates.map((m) => {
                const st = MANDATE_STATUS[m.status];
                const who = [...m.roles.map((r) => ROLE_PLURAL[r] ?? r), ...m.payees].join(", ");
                return (
                  <div key={m.id} className="grid gap-2 rounded border border-[color:var(--rule)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{m.agent}</p>
                      <TonePill tone={st.tone}>{st.label}</TonePill>
                    </div>
                    <p className="text-ink-soft">
                      Up to <span className="num text-ink">{formatMoney(m.perPaymentMinor, m.currency, { code: true })}</span> a payment to {who}
                      {m.purpose ? `. ${PURPOSE_LABEL[m.purpose]}` : ""}. Until <span className="num">{m.validUntil.slice(0, 10)}</span>.
                    </p>
                    {m.note ? <p className="text-xs text-ink-soft">{m.note}</p> : null}
                    <BudgetBar spentMinor={m.spentMinor} totalMinor={m.totalMinor} currency={m.currency} active={m.status === "active"} />
                    <p className="text-xs text-ink-soft">
                      {pluralise(m.requests, "request")} under it. Issued by {m.issuedBy.replace(/^user:/, "")}
                      {m.revokedAt ? (
                        <>
                          , revoked <RelativeTime iso={m.revokedAt} />
                        </>
                      ) : null}
                      .
                    </p>
                    {isOwner && m.status !== "revoked" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {m.status === "active" ? (
                          <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
                            Copy the mandate for the agent <CopyButton value={m.token} label={`Copy the mandate for ${m.agent}`} />
                          </span>
                        ) : null}
                        <RevokeMandateButton id={m.id} agent={m.agent} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {signer ? (
                <div>
                  <p className="dense text-ink-soft">Signed with Ed25519. Anyone can verify a mandate with this public key</p>
                  <p className="num mt-1 flex items-center gap-1 break-all text-2xs leading-4">
                    {signer.stellar} <CopyButton value={signer.stellar} label="Copy the public key" />
                  </p>
                </div>
              ) : (
                <p className="text-xs text-attention">Mandates cannot be signed here: set CHECKRAIL_DATA_KEY.</p>
              )}
              {isOwner && signer ? (
                <details className="border-t pt-3 hairline">
                  <summary className="cursor-pointer font-medium">Issue a mandate</summary>
                  <div className="mt-3">
                    <IssueMandateForm
                      agents={[...new Set(["claude-desktop", ...s.agents.filter((a) => !a.scopes.includes("supplier")).map((a) => a.name)])]}
                      suppliers={suppliers.map(({ id, name }) => ({ id, name }))}
                      roles={[...new Set(suppliers.map((v) => v.role).filter((r): r is string => Boolean(r)))]}
                      currencies={SUPPORTED_CURRENCIES}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          </Panel>

          <Panel title="Connect an agent">
            <div className="grid min-w-0 gap-4 text-sm">
              <div>
                <p className="dense text-ink-soft">Endpoint (MCP over HTTP)</p>
                <p className="num mt-1 flex items-center gap-1 break-all">
                  {url} <CopyButton value={url} label="Copy the endpoint" />
                </p>
                <p className="mt-1 text-xs text-ink-soft">{open ? "Open on this demo: an agent can call it without a key, on simulated rails; each caller gets a name of its own." : "Each agent sends its key as Authorization: Bearer <key>."}</p>
              </div>
              <div>
                <p className="dense text-ink-soft">Claude Code</p>
                <pre className="num mt-1 max-w-full whitespace-pre-wrap break-all rounded bg-paper p-2 text-2xs leading-4" style={{ fontFamily: "inherit" }}>
                  {claudeCode}
                </pre>
              </div>
              <div>
                <p className="dense text-ink-soft">Claude Desktop, on the machine that runs Checkrail</p>
                <pre className="num mt-1 max-w-full whitespace-pre-wrap break-all rounded bg-paper p-2 text-2xs leading-4" style={{ fontFamily: "inherit" }}>
                  {desktop}
                </pre>
                <p className="mt-1 text-xs text-ink-soft">Checks only. Add &quot;--allow-requests&quot; after &quot;mcp&quot; to let it put requests in the inbox.</p>
              </div>
            </div>
          </Panel>

          <Panel title="What an agent can do">
            <ul className="grid gap-2 text-sm">
              <li>
                <span className="font-medium">Checks only.</span> Ask whether a payment would pass, look up a payee, read what a rule means. Nothing is saved but a line on this page.
              </li>
              <li>
                <span className="font-medium">Checks and requests.</span> Also put a payment in your inbox. What it attaches is its own say-so, so a person approves unless your own records already support the payment.
              </li>
              <li>
                <span className="font-medium">System of record.</span> For your booking or dispatch system&apos;s own agent: what it attaches counts as your records. Your caps, the cancel window and the re-check at release still apply.
              </li>
              <li>
                <span className="font-medium">A supplier&apos;s own agent.</span> Checks and requests for that one supplier only. Asking more than your records support gets a counter-offer it can accept or dispute; it never sees other suppliers or your rules.
              </li>
              <li className="text-ink-soft">No agent can approve, release or send a payment, or see a supplier&apos;s payout details. An agent trying {pluralise(3, "amount")} for one payee is held for a person.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "attention" | "settled" | "blocked" }) {
  const colour = tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : tone === "blocked" ? "text-blocked" : "";
  return (
    <div className="panel min-w-0 px-5 py-4">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1.5 text-[26px] leading-8 ${colour}`}>{value}</dd>
      {note ? <dd className="mt-1 text-[13px] leading-[18px] text-ink-soft">{note}</dd> : null}
    </div>
  );
}
