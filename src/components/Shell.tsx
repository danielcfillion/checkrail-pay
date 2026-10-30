import type { ReactNode } from "react";
import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { WhoAmI } from "./WhoAmI";
import { railLabel } from "@/lib/format";
import { configuredUsers, personasAllowed } from "@/lib/basicAuth";
import { BrandMark } from "./BrandMark";

export type SystemModes = { railModes: Record<string, string>; ai: string; accounting: string };

export const NAV = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/obligations", label: "Inbox", icon: "inbox" },
  { href: "/runs", label: "Payment runs", icon: "runs" },
  { href: "/agents", label: "Agents", icon: "agents" },
  { href: "/vendors", label: "Vendors", icon: "vendors" },
  { href: "/ledger", label: "Ledger", icon: "ledger" },
  { href: "/exceptions", label: "Exceptions", icon: "exceptions" },
  { href: "/close", label: "Daily close", icon: "close" },
  { href: "/accounting", label: "Accounting", icon: "accounting" },
  { href: "/books", label: "Books", icon: "books" },
  { href: "/audit", label: "Audit", icon: "audit" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export type WhoProps = { name: string; role: string; username: string; viaLogin?: string; personas: ReadonlyArray<{ username: string; name: string; role: string }> | null; waiting: number; vendorChecks?: number; runsToRelease?: number };

export function Shell({ businessName, system, who, children }: { businessName: string | null; system: SystemModes | null; who?: WhoProps | null; children: ReactNode }) {
  const demoGuide = personasAllowed(process.env, (configuredUsers() ?? []).length > 0);
  // The judge's surface: four sections lead and the rest sit under More (business review, fix 8).
  const trimmed = demoGuide;
  const modes = system ? modeSummary(system) : null;
  const phoneExtras = { personas: who?.personas ?? null, username: who?.username ?? "", modes };
  return (
    <div className="min-h-screen md:grid md:grid-cols-[64px_1fr] lg:grid-cols-[220px_1fr]">
      <aside aria-label="Sidebar" className="hidden md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-r hairline">
        <div className="px-3 py-4 lg:px-5">
          <Link href="/" className="flex items-center gap-2 rounded-sm" aria-label="Checkrail Pay, overview">
            <BrandMark size={26} className="shrink-0" />
            <span className="wide hidden whitespace-nowrap text-lg leading-6 lg:inline">Checkrail Pay</span>
          </Link>
          <p className="mt-0.5 hidden truncate text-xs text-ink-soft lg:block" title={businessName ?? undefined}>
            {businessName ?? "No business configured"}
          </p>
        </div>
        <nav className="flex-1 px-2 lg:px-3" aria-label="Main">
          <NavLinks items={NAV} demoGuide={demoGuide} trimmed={trimmed} />
        </nav>
        {who ? <WhoAmI {...who} /> : null}
        <SystemFooter system={system} />
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-between gap-3 border-b hairline bg-sheet px-4 py-2.5 md:hidden">
          <Link href="/" className="flex min-w-0 items-center gap-2 rounded-sm" aria-label="Checkrail Pay, overview">
            <BrandMark size={24} className="shrink-0" />
            <span className="wide whitespace-nowrap text-base leading-5">Checkrail Pay</span>
          </Link>
          {businessName ? <span className="truncate text-xs text-ink-soft">{businessName}</span> : null}
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1320px] focus:outline-none px-4 pb-24 pt-5 sm:px-6 md:pb-10 md:pt-6">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t hairline bg-sheet md:hidden" aria-label="Main, mobile">
        <NavLinks items={NAV} mobile demoGuide={demoGuide} trimmed={trimmed} phone={phoneExtras} />
      </nav>
    </div>
  );
}

/** Is a mode simulated? Mock rails, an unconnected rail, the demo bank file and the rule-based reader all are. */
const simulated = (mode: string) => /mock|demo|not connected/i.test(mode);

/**
 * One line instead of six: "Demo mode" when nothing is live, otherwise what is live ("Live: PayPal sandbox,
 * Claude"). The full list sits behind it, and stays in Settings, System.
 */
export function modeSummary(system: SystemModes): { summary: string; live: boolean; rows: Array<[string, string, boolean]> } {
  const rails = Object.entries(system.railModes);
  const rows: Array<[string, string, boolean]> = [...rails.map(([rail, mode]): [string, string, boolean] => [railLabel(rail), mode, simulated(mode)]), ["Agent", system.ai, simulated(system.ai)], ["Books", system.accounting, simulated(system.accounting)]];
  const live = [
    ...rails.filter(([, m]) => !simulated(m)).map(([rail, m]) => (rail === "bank_file" ? "Bank file" : `${railLabel(rail)} ${m}`)),
    ...(simulated(system.ai) ? [] : ["Claude"]),
  ];
  return { summary: live.length ? `Live: ${live.join(", ")}` : "Demo mode", live: live.length > 0, rows };
}

function SystemFooter({ system }: { system: SystemModes | null }) {
  if (!system) return null;
  const m = modeSummary(system);
  const rows = m.rows;
  const live = m.live ? [m.summary] : [];
  const summary = m.summary;
  const tone = live.length ? "text-ink" : "text-attention";
  // The sidebar sits on paper; lay the tint over sheet so the pill keeps 4.5:1.
  const fill = `linear-gradient(var(${live.length ? "--neutral-soft" : "--attention-soft"}), var(${live.length ? "--neutral-soft" : "--attention-soft"})), var(--sheet)`;
  return (
    <div className="border-t hairline px-3 py-3 lg:px-5">
      <details className="system-modes relative hidden lg:block">
        <summary className={`rounded-full px-2.5 hover:border-transparent ${tone}`} style={{ background: fill }} title="Rail and agent modes">
          <span className="truncate">{summary}</span>
        </summary>
        <div className="panel absolute bottom-full left-0 z-30 mb-2 w-[220px] p-3" role="group" aria-label="System modes">
          <p className="dense mb-1.5 text-ink-soft">{live.length ? "Rail and agent modes" : "Nothing here moves real money"}</p>
          <ul className="dense space-y-1">
            {rows.map(([label, mode, sim]) => (
              <li key={label} className="flex justify-between gap-3">
                <span className="text-ink-soft">{label}</span>
                <span className={`truncate text-right ${sim ? "text-ink-soft" : "text-ink"}`} title={mode}>
                  {mode}
                </span>
              </li>
            ))}
          </ul>
          <Link href="/settings" className="link dense mt-2 inline-block">
            Modes in Settings
          </Link>
        </div>
      </details>
      <p className={`dense rounded-full py-0.5 text-center lg:hidden ${tone}`} style={{ background: fill }} title={`${rows.map(([l, m]) => `${l} ${m}`).join(", ")}`}>
        {live.length ? "Live" : "Demo"}
      </p>
    </div>
  );
}
