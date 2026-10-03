import { getBusiness, getSystemModes } from "@/lib/queries";
import { DEFAULT_POLICY, type ApprovalPolicy } from "@/lib/domain/types";
import { countryName, formatMoney, railLabel } from "@/lib/format";
import { EmptyState, KeyValue, PageHeader, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
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

  const sentences: string[] = [
    `Auto-pay up to ${formatMoney(policy.autoExecuteThresholdMinor, cur)} when evidence matches. Above that, a person approves.`,
    policy.dualApprovalThresholdMinor > 0 ? `Above ${formatMoney(policy.dualApprovalThresholdMinor, cur)}, two people approve.` : "Dual approval is off.",
    `Allow the requested amount to differ from the evidence by up to ${(policy.amountToleranceBps / 100).toFixed(2)}%. Beyond that, block.`,
    policy.requireEvidence ? "Never pay without a job sheet, invoice, contract or booking attached." : "Evidence is recommended but not required.",
    policy.blockOnRecipientChange ? "Block any payment to a vendor whose payout details changed since they were last verified." : "Changed payout details do not block payments.",
    `Hold for review when the agent's confidence is below ${policy.minAiConfidence}%.`,
    `Pay only along enabled corridors: ${policy.allowedCorridors.map(corridorText).join(", ")}.`,
  ];

  return (
    <>
      <PageHeader title="Settings" lede="Read-only in this build. Policy is a JSON document on the business record; these are the same rules written out." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Business">
          <KeyValue
            rows={[
              ["Name", biz.name],
              ["Base currency", cur],
              ["Country", countryName(biz.country)],
              ["Operator", "Daniel (user:daniel)"],
            ]}
          />
        </Panel>

        <Panel title="Modes" aside="honest about what is live">
          <KeyValue
            rows={[
              ...Object.entries(system.railModes).map(([rail, mode]) => [railLabel(rail), <ModeText key={rail} mode={mode} />] as [string, React.ReactNode]),
              ["Agent", system.ai],
              ["Accounting", system.accounting === "xero" ? "Xero (live destination)" : "CSV export, Xero record shape"],
            ]}
          />
        </Panel>

        <Panel title="Approval policy" className="lg:col-span-2">
          <ol className="list-decimal space-y-2 pl-5">
            {sentences.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <details className="mt-4 border-t pt-3 hairline">
            <summary className="dense text-ink-soft hover:text-ink">Raw policy JSON</summary>
            <pre className="num mt-2 overflow-auto rounded bg-paper p-3 text-xs leading-4 text-ink-soft" style={{ fontFamily: "inherit", fontStretch: "92%" }}>
              {JSON.stringify(policy, null, 2)}
            </pre>
          </details>
        </Panel>

        <Panel title="Switching to live mode" className="lg:col-span-2">
          <p className="text-ink-soft">Everything runs with zero credentials in mock mode. To move a rail or the agent to live, set these in .env (see .env.example) and restart. A rail missing credentials falls back to mock and says so in the sidebar.</p>
          <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <EnvBlock title="Rails" lines={["RAIL_MODE=live", "PAYPAL_CLIENT_ID=…", "PAYPAL_CLIENT_SECRET=…", "PAYPAL_ENV=sandbox", "STELLAR_NETWORK=testnet", "STELLAR_TREASURY_SECRET=S…", "STELLAR_PYUSD_ISSUER=G…"]} />
            <EnvBlock title="Agent and books" lines={["AI_MODE=live", "ANTHROPIC_API_KEY=sk-ant-…", "ANTHROPIC_MODEL=claude-sonnet-4-5", "ACCOUNTING_DESTINATION=xero", "XERO_CLIENT_ID=…", "XERO_CLIENT_SECRET=…"]} />
          </dl>
        </Panel>
      </div>
    </>
  );
}

function ModeText({ mode }: { mode: string }) {
  const live = mode === "live";
  return <span className={live ? "text-settled" : ""}>{mode}{mode === "mock" ? " (deterministic, offline)" : mode === "sandbox" || mode === "testnet" ? " (no real money)" : ""}</span>;
}

function EnvBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <dt className="dense text-ink-soft">{title}</dt>
      <dd>
        <pre className="num mt-1 overflow-auto rounded bg-paper p-3 text-xs leading-5" style={{ fontFamily: "inherit", fontStretch: "92%" }}>
          {lines.join("\n")}
        </pre>
      </dd>
    </div>
  );
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
