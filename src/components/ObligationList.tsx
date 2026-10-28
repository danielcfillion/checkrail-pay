import Link from "next/link";
import type { ObligationRow } from "@/lib/queries";
import { CheckLine } from "./CheckLine";
import { Money, RailTag, RelativeTime, StatePill } from "./ui";

/** One-line reason for a row in a "needs you" list. */
const tidy = (s: string) => s.replace(/obligation obl_[a-z0-9]+ \((\w+)\)/i, "an earlier request ($1)");

export function reasonFor(r: ObligationRow): string {
  if (r.blockedReason) return tidy(r.blockedReason);
  const reasons = safeParse(r.policyReasonsJson);
  if (r.state === "approved") return r.routeReason ? `Ready to pay. ${r.routeReason}` : "Ready to pay.";
  if (reasons.length) return reasons[0];
  if (r.routeReason) return r.routeReason;
  return "";
}

/** The next action a person would take, as a short verb phrase. */
export function nextStepFor(state: string): string {
  switch (state) {
    case "blocked":
      return "Review";
    case "failed":
      return "Retry or cancel";
    case "awaiting_approval":
      return "Approve";
    case "approved":
      return "Pay";
    case "needs_evidence":
      return "Add evidence";
    case "sent":
      return "Check settlement";
    default:
      return "Open";
  }
}

function safeParse(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Compact, quiet list: vendor, reference, amount, state line, one reason. */
export function NeedsYouList({ rows }: { rows: ObligationRow[] }) {
  return (
    <ul className="divide-y hairline">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/obligations/${r.id}`} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3 hover:bg-paper/60 sm:grid-cols-[minmax(0,1fr)_96px_120px_110px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{r.vendorName ?? "Unknown vendor"}</span>
                <span className="num whitespace-nowrap text-ink-soft">{r.sourceRef ?? "no reference"}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-ink-soft" title={reasonFor(r)}>
                {reasonFor(r)}
              </p>
            </div>
            <div className="hidden items-center sm:flex" style={{ height: 20 }}>
              <CheckLine state={r.state} variant="compact" hasAccounting />
            </div>
            <div className="hidden sm:flex sm:flex-col sm:items-start">
              <StatePill state={r.state} />
              <span className="dense text-ink-soft">{nextStepFor(r.state)}</span>
            </div>
            <div className="shrink-0 text-right">
              <Money minor={r.amountMinor} currency={r.currency} className="font-medium whitespace-nowrap" />
              <div className="mt-0.5 sm:hidden">
                <StatePill state={r.state} />
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The inbox. From 640px a ledger table; below it, two-line rows (vendor and amount, then reference, state and rail)
 * where the whole row is the tap target, so nothing is clipped at the screen edge.
 */
export function ObligationTable({ rows }: { rows: ObligationRow[] }) {
  return (
    <>
      <ObligationCards rows={rows} />
      <ObligationLedger rows={rows} />
    </>
  );
}

function ObligationCards({ rows }: { rows: ObligationRow[] }) {
  return (
    <ul className="panel divide-y hairline sm:hidden">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/obligations/${r.id}`} className="block min-h-11 px-4 py-3 active:bg-paper">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">{r.vendorName ?? "Unknown vendor"}</span>
              <Money minor={r.amountMinor} currency={r.currency} className="shrink-0 whitespace-nowrap font-medium" />
            </span>
            <span className="mt-1 flex items-center gap-2">
              <span className="num min-w-0 truncate text-xs text-ink-soft">{r.sourceRef ?? "no reference"}</span>
              <StatePill state={r.state} className="shrink-0" />
              <RailTag rail={r.selectedRail} className="ml-auto shrink-0" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ObligationLedger({ rows }: { rows: ObligationRow[] }) {
  return (
    <div className="panel overflow-x-auto max-sm:hidden">
      <table className="ledger">
        <thead>
          <tr>
            <th scope="col">Vendor</th>
            <th scope="col">Reference</th>
            <th scope="col" className="hidden lg:table-cell">
              Description
            </th>
            <th scope="col" className="r">
              Amount
            </th>
            <th scope="col">State</th>
            <th scope="col">Rail</th>
            <th scope="col" className="hidden md:table-cell">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="row-link relative">
              <td className="whitespace-nowrap font-medium">
                <Link href={`/obligations/${r.id}`} className="after:absolute after:inset-0 after:content-['']">
                  {r.vendorName ?? "Unknown vendor"}
                </Link>
              </td>
              <td className="num whitespace-nowrap text-ink-soft">{r.sourceRef ?? "none"}</td>
              <td className="hidden max-w-[320px] truncate text-ink-soft lg:table-cell" title={r.description ?? r.rawInput}>
                {stripVendorPrefix(r.description, r.vendorName) ?? r.rawInput}
              </td>
              <td className="r whitespace-nowrap">
                <Money minor={r.amountMinor} currency={r.currency} />
              </td>
              <td className="whitespace-nowrap">
                <div className="flex items-center gap-2.5">
                  <CheckLine state={r.state} variant="compact" hasAccounting />
                  <StatePill state={r.state} />
                </div>
              </td>
              <td className="whitespace-nowrap">
                <RailTag rail={r.selectedRail} />
              </td>
              <td className="hidden whitespace-nowrap text-ink-soft md:table-cell">
                <RelativeTime iso={r.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Descriptions are stored as "Vendor (REF): text". The table already shows vendor and ref. */
export function stripVendorPrefix(description: string | null | undefined, vendor: string | null | undefined): string | null {
  if (!description) return null;
  const idx = description.indexOf("): ");
  if (vendor && description.startsWith(vendor) && idx > 0) return description.slice(idx + 3);
  if (vendor && description.startsWith(vendor + ": ")) return description.slice(vendor.length + 2);
  return description;
}
