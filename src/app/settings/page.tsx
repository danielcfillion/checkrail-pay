import { getBusiness, getSystemModes } from "@/lib/queries";
import { DEFAULT_POLICY, type ApprovalPolicy } from "@/lib/domain/types";
import { countryName, formatDate, formatMoney, formatMoneyShort, formatMoneySymbol, railLabel } from "@/lib/format";
import { EmptyState, KeyValue, PageHeader, Panel } from "@/components/ui";
import { AutonomyControl } from "@/components/AutonomyControl";
import { CapMeter } from "@/components/CapMeter";
import { autopilotStatus } from "@/lib/engine/autopilot";
import { getDb } from "@/lib/db";
import { getViewer } from "@/lib/viewer";
import { listTeam, whoIs } from "@/lib/engine/users";
import { DEMO_PERSONAS, ROLE_LABEL, can, isRole } from "@/lib/auth/roles";
import { TeamPanel } from "@/components/TeamPanel";
import { TaxSettings } from "@/components/TaxSettings";
import { fxAsOf, fxTable } from "@/lib/fx";
import { SUPPORTED_CURRENCIES } from "@/lib/domain/money";
import { usingDevKey } from "@/lib/crypto/dataKey";
import { dualControlGap } from "@/lib/engine/orchestrator";
import { taxFeaturesOn } from "@/lib/features";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const SECTIONS = [
  { id: "autonomy", label: "Autonomy" },
  { id: "team", label: "Team and limits" },
  { id: "rules", label: "Approval rules" },
  { id: "tax", label: "Tax and currencies" },
  { id: "system", label: "System" },
] as const;

export default async function SettingsPage() {
  const viewer = await getViewer();
  const biz = getBusiness();
  const system = getSystemModes();
  if (!biz) {
    return (
      <>
        <PageHeader title="Settings" />
        <EmptyState title="No business configured" body="Reset the demo from the overview to load Ridgeline Expeditions and its policy." />
      </>
    );
  }
  const policy = parsePolicy(biz.policyJson);
  const cur = biz.baseCurrency;
  const ap = autopilotStatus(getDb(), biz.id);
  const symbol = formatMoneySymbol(0, cur).replace(/[\d.,\s]+$/, "");
  const mayChange = !viewer || viewer.can("settings");
  const demo = Boolean(viewer?.personas);
  const personaNames = new Set(DEMO_PERSONAS.map((p) => p.username));
  // In the demo one owner login plays every persona: the login itself is not a second owner, so it is not listed.
  const login = viewer?.login ?? null;
  const team = listTeam(getDb(), biz.id)
    .filter((u) => isRole(u.role))
    .filter((u) => !demo || personaNames.has(u.id))
    .map((u) => ({ username: u.id, displayName: u.displayName, role: u.role, roleLabel: ROLE_LABEL[u.role as keyof typeof ROLE_LABEL], approvalLimitMinor: u.approvalLimitMinor, delegateTo: u.delegateTo, delegateUntil: u.delegateUntil, active: u.active, canApprove: can(u.role as keyof typeof ROLE_LABEL, "approve") }));
  const approverPersonas = team.filter((t) => t.canApprove && t.active && t.role !== "admin").map((t) => t.displayName.split(" ")[0]);
  const rawGap = dualControlGap(getDb(), biz.id);
  // Two-person approval counts logins, not personas. In the demo, say how to give the second approval instead.
  const dualGap = rawGap && demo && login
    ? `Logins: only ${login} is configured, so above ${formatMoneyShort(policy.dualApprovalThresholdMinor, cur)} two different logins must approve. In this demo, switch role to ${approverPersonas[0] ?? "Minh"} (sidebar, or More on a phone) to see a second approval.`
    : rawGap;
  const identity = viewer ? (viewer.actor.viaLogin ? `${viewer.actor.displayName.includes("(") ? viewer.actor.displayName : whoIs(viewer.actor)}, demo login ${viewer.actor.viaLogin}` : whoIs(viewer.actor)) : "not signed in";

  const sentences: string[] = [
    `On Assist, pre-approve up to ${formatMoney(policy.autoExecuteThresholdMinor, cur)} when evidence matches. Above that, a person approves.`,
    policy.dualApprovalThresholdMinor > 0 ? `Above ${formatMoney(policy.dualApprovalThresholdMinor, cur)}, two people approve.` : "Dual approval is off.",
    `Allow the requested amount to differ from the evidence by up to ${(policy.amountToleranceBps / 100).toFixed(2)}%. Beyond that, block.`,
    "Pay a request without a person only when a job sheet, booking or purchase order from your own systems, or the rate card, confirms the amount. A vendor's own invoice always goes to a person.",
    policy.requireEvidence ? "Never pay without a job sheet, invoice, contract or booking attached." : "Evidence is recommended but not required.",
    policy.blockOnRecipientChange ? "Block any payment to a vendor whose payout details changed since they were last verified." : "Changed payout details do not block payments.",
    `Hold for review when the agent's confidence is below ${policy.minAiConfidence}%.`,
    policy.vendorDailyCapMinor ? `Ask a person once one vendor passes ${formatMoney(policy.vendorDailyCapMinor, cur)} in 24 hours.` : "No per-vendor daily limit.",
    `Pay only along enabled corridors: ${policy.allowedCorridors.map(corridorText).join(", ")}.`,
  ];

  return (
    <>
      <PageHeader title="Settings" lede="Choose how much the agent does without asking. The approval rules underneath stay the same at every level." />
      <nav aria-label="Settings sections" className="tabs-scroll sticky top-0 z-30 -mx-4 mb-6 overflow-x-auto border-b bg-paper px-4 hairline sm:-mx-6 sm:px-6 md:[mask-image:none] md:[-webkit-mask-image:none]">
        <ul className="flex w-max gap-1 py-2 pr-16 text-sm md:pr-0">
          {SECTIONS.map((x) => (
            <li key={x.id} className="shrink-0">
              <a href={`#${x.id}`} className="btn btn-sm whitespace-nowrap">
                {x.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="space-y-10">
        <Section id="autonomy" title="Autonomy">
          <Panel title="How much the agent does" aside={ap.level === "autopilot" ? (ap.paused ? "autopilot paused" : "autopilot on") : ap.level === "review" ? "a person approves everything" : "a person sends"}>
            {mayChange ? (
              <AutonomyControl
                key={`${ap.level}-${ap.paused}-${ap.perPaymentCapMinor}-${ap.dailyCapMinor}-${ap.cancelWindowSeconds}`}
                view={{ level: ap.level, paused: ap.paused, perPaymentCapMinor: ap.perPaymentCapMinor, dailyCapMinor: ap.dailyCapMinor, cancelWindowSeconds: ap.cancelWindowSeconds, committed24hMinor: ap.committed24hMinor, autoApproveMinor: policy.autoExecuteThresholdMinor, dualApprovalMinor: policy.dualApprovalThresholdMinor, symbol }}
              />
            ) : (
              <p className="text-ink-soft">
                {ap.level === "autopilot" ? `Autopilot${ap.paused ? " (paused)" : ""}: up to ${formatMoney(ap.perPaymentCapMinor, cur)} a payment and ${formatMoney(ap.dailyCapMinor, cur)} a day, with a ${Math.round(ap.cancelWindowSeconds / 60)} minute cancel window.` : ap.level === "review" ? "Review: a person approves and sends every payment." : "Assist: clean small requests are approved for you. A person sends them."} Only the owner changes this.
              </p>
            )}
            {ap.level === "autopilot" ? (
              <div className="mt-5 max-w-md border-t pt-4 hairline">
                <CapMeter label="Daily cap used, all payments" usedMinor={ap.committed24hMinor} capMinor={ap.dailyCapMinor} currency={cur} />
              </div>
            ) : null}
          </Panel>
        </Section>

        <Section id="team" title="Team and limits">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Panel title="Team" aside={viewer?.can("manage_users") ? "roles come from the login settings" : "the owner edits this"}>
              {dualGap ? <p className="mb-3 rounded border border-attention bg-attention-soft px-3 py-2 text-sm text-ink" role="status">{dualGap}</p> : null}
              <TeamPanel rows={team} editable={Boolean(viewer?.can("manage_users"))} symbol={symbol} me={viewer?.actor.username ?? null} />
              <p className="mt-3 text-xs text-ink-soft">Whoever prepares a payment (creates it or changes its amount, payee or reference) cannot also approve it while someone else can. Cover while away hands that person&apos;s approvals and limit to the named colleague until the end date. Every change here is in the audit log.</p>
            </Panel>
            <Panel title="Business">
              <KeyValue
                rows={[
                  ["Name", biz.name],
                  ["Base currency", cur],
                  ["Country", countryName(biz.country)],
                  ["Signed in as", identity],
                ]}
              />
            </Panel>
          </div>
        </Section>

        <Section id="rules" title="Approval rules">
          <Panel title="The rules" aside="apply at every autonomy level">
            <ol className="list-decimal space-y-2 pl-5">
              {sentences.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
            <details className="mt-4 border-t pt-3 hairline">
              <summary className="dense text-ink-soft hover:text-ink">Raw policy JSON</summary>
              <pre className="num mt-2 overflow-auto rounded bg-paper p-3 text-xs leading-4 text-ink-soft" style={{ fontFamily: "inherit", fontStretch: "92%" }}>
                {JSON.stringify(policy, null, 2)}
              </pre>
            </details>
          </Panel>
        </Section>

        <Section id="tax" title="Tax and currencies">
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Currencies" aside={`reference rates as of ${formatDate(fxAsOf())}`}>
              <p className="mb-3 text-ink-soft">Invoices can be in {SUPPORTED_CURRENCIES.join(", ")}. Every limit, cap and total is checked in {cur} at these rates. What the vendor receives comes from the rail&apos;s own quote.</p>
              <KeyValue rows={fxTable().filter((r) => r.currency !== "USD").map((r) => [`1 USD`, `${r.perUsd.toLocaleString("en-US")} ${r.currency}`] as [string, string])} />
              <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">Full bank account numbers are stored encrypted{usingDevKey() ? " with a development key. Set a real key before real use (see the README)" : ""}.</p>
            </Panel>
            <Panel title="Tax" aside="guidance, not tax advice">
              <p className={taxFeaturesOn() ? "mb-3 text-ink-soft" : "text-ink-soft"}>A US payee without a W-9 has 24% withheld. Payees abroad need a W-8 on file before they are paid without a second look.{taxFeaturesOn() ? " US payees paid USD 2,000 or more in a year are listed for a 1099-NEC on the Books page." : ""}</p>
              {taxFeaturesOn() ? <TaxSettings vnPit={Boolean(policy.withholdVnPit)} phEwt={Boolean(policy.withholdPhEwt)} editable={mayChange} /> : null}
            </Panel>
          </div>
        </Section>

        <Section id="system" title="System">
          <Panel title="Modes" aside="honest about what is live">
            <KeyValue
              rows={[
                ...Object.entries(system.railModes).map(([rail, mode]) => [railLabel(rail), <ModeText key={rail} mode={mode} />] as [string, React.ReactNode]),
                ["Agent", system.ai],
                ["Accounting", system.accounting === "xero" ? "Xero (live destination)" : "CSV export, Xero record shape"],
              ]}
            />
            <p className="mt-3 border-t pt-3 text-ink-soft hairline">
              {Object.values(system.railModes).every((m) => m === "mock") && !/claude/i.test(system.ai)
                ? "Rails and agent are in demo mode. See the README to connect PayPal, Stellar and Claude."
                : "To change a rail or the agent, see Live mode setup in the README."}
            </p>
          </Panel>
        </Section>
      </div>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-16">
      <h2 id={`${id}-h`} className="mb-3 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModeText({ mode }: { mode: string }) {
  const live = mode === "live";
  return <span className={live ? "text-settled" : ""}>{mode}{mode === "mock" ? " (deterministic, offline)" : mode === "sandbox" || mode === "testnet" ? " (no real money)" : ""}</span>;
}

function corridorText(c: string): string {
  const [from, to] = c.split("->");
  return from === to ? `${countryName(from)} domestic` : `${countryName(from)} to ${countryName(to)}`;
}

function parsePolicy(json: string): ApprovalPolicy {
  try {
    return { ...DEFAULT_POLICY, ...(JSON.parse(json) as Partial<ApprovalPolicy>) };
  } catch {
    return DEFAULT_POLICY;
  }
}
