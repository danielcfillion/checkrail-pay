import type { ReactNode } from "react";
import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { WhoAmI } from "./WhoAmI";
import { railLabel } from "@/lib/format";
import { configuredUsers, personasAllowed } from "@/lib/basicAuth";

export type SystemModes = { railModes: Record<string, string>; ai: string; accounting: string };

export const NAV = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/obligations", label: "Inbox", icon: "inbox" },
  { href: "/runs", label: "Payment runs", icon: "runs" },
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
  return (
    <div className="min-h-screen md:grid md:grid-cols-[64px_1fr] lg:grid-cols-[220px_1fr]">
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-r hairline">
        <div className="px-3 py-4 lg:px-5">
          <Link href="/" className="wide block text-lg leading-6" aria-label="Checkrail Pay, overview">
            <span className="hidden lg:inline">Checkrail Pay</span>
            <span className="lg:hidden" aria-hidden>
              C
            </span>
          </Link>
          <p className="mt-0.5 hidden truncate text-xs text-ink-soft lg:block" title={businessName ?? undefined}>
            {businessName ?? "No business configured"}
          </p>
        </div>
        <nav className="flex-1 px-2 lg:px-3" aria-label="Main">
          <NavLinks items={NAV} demoGuide={demoGuide} />
        </nav>
        {who ? <WhoAmI {...who} /> : null}
        <SystemFooter system={system} />
      </aside>
      <div className="min-w-0">
        <main className="mx-auto w-full max-w-[1320px] px-4 pb-24 pt-5 sm:px-6 md:pb-10 md:pt-6">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t hairline bg-sheet md:hidden" aria-label="Main, mobile">
        <NavLinks items={NAV} mobile demoGuide={demoGuide} />
      </nav>
    </div>
  );
}

function SystemFooter({ system }: { system: SystemModes | null }) {
  if (!system) return null;
  const rails = Object.entries(system.railModes);
  return (
    <div className="border-t hairline px-3 py-3 lg:px-5" aria-label="System modes">
      <ul className="dense hidden space-y-0.5 text-ink-soft lg:block">
        {rails.map(([rail, mode]) => (
          <li key={rail} className="flex justify-between gap-2">
            <span>{railLabel(rail)}</span>
            <span className="num">{mode}</span>
          </li>
        ))}
        <li className="flex justify-between gap-2">
          <span>Agent</span>
          <span className="truncate" title={system.ai}>
            {system.ai}
          </span>
        </li>
        <li className="flex justify-between gap-2">
          <span>Books</span>
          <span>{system.accounting}</span>
        </li>
      </ul>
      <p className="dense text-center text-ink-soft lg:hidden" title={`${rails.map(([r, m]) => `${railLabel(r)} ${m}`).join(", ")}, agent ${system.ai}`}>
        {rails.every(([, m]) => m === "mock") ? "mock" : "live"}
      </p>
    </div>
  );
}
