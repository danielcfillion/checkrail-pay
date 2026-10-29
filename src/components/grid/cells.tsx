"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoney } from "@/lib/format";
import { RailTag, StatePill } from "../ui";
import { RECON_LABEL, type ReconState } from "./model";

/* Cell renderers shared by the grids and their phone card rows. Small, stateless, the app's own pieces. */

const RECON_TONE: Record<ReconState, string> = {
  reconciled: "bg-settled-soft text-settled",
  in_books: "bg-neutral-soft text-ink",
  open: "bg-attention-soft text-attention",
};

const RECON_ICON: Record<ReconState, string> = {
  reconciled: "M3.25 6.25l1.9 1.9L8.9 4.2",
  in_books: "M3.5 3h5v6h-5zM5 5h2",
  open: "M6 3.5V6l1.6 1.2",
};

export const RECON_HELP: Record<ReconState, string> = {
  reconciled: "Matched to a line on the provider's statement",
  in_books: "Sent to the books; not yet matched to a statement line",
  open: "Not in the books and not matched to a statement yet",
};

export function ReconPill({ state }: { state: ReconState }) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-4 ${RECON_TONE[state]}`} title={RECON_HELP[state]}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="shrink-0">
        {state === "open" ? <circle cx="6" cy="6" r="4.4" strokeWidth="1.3" /> : null}
        <path d={RECON_ICON[state]} />
      </svg>
      {RECON_LABEL[state]}
    </span>
  );
}

export function RailCell({ rail }: { rail: string | null | undefined }) {
  return <RailTag rail={rail} />;
}

export { StatePill };

/** "USD 180.00", tabular. */
export function MoneyCell({ minor, currency, soft = false }: { minor: number | null | undefined; currency: string | null | undefined; soft?: boolean }) {
  if (minor === null || minor === undefined) return <span className="num text-ink-soft">pending</span>;
  return <span className={`num whitespace-nowrap ${soft ? "text-ink-soft" : ""}`}>{formatMoney(minor, currency)}</span>;
}

export function DecidedCell({ kind, label }: { kind: "agent" | "person" | "unknown"; label: string }) {
  if (kind === "agent")
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="dense inline-flex h-5 items-center rounded-sm bg-neutral-soft px-1.5 text-ink">Agent</span>
        <span>{label}</span>
      </span>
    );
  return <span className={kind === "unknown" ? "text-ink-soft" : ""}>{label}</span>;
}

/** A link inside a grid cell: underlined like body links, reachable with Enter on the focused cell. */
export function CellLink({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  return (
    <Link href={href} className="cr-cell-link" aria-label={label} tabIndex={-1}>
      {children}
    </Link>
  );
}
