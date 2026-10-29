import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoney, formatMoneySymbol, railLabel, stateLabel, timeAgo, formatDateTime } from "@/lib/format";
import { STATION_LABELS, type Station } from "./checkline-model";

/* Small, server-safe presentational pieces. */

export function Money({ minor, currency, symbol = false, className = "" }: { minor: number | null | undefined; currency: string | null | undefined; symbol?: boolean; className?: string }) {
  if (minor === null || minor === undefined) return <span className={`num text-ink-soft ${className}`}>no amount</span>;
  return <span className={`num ${className}`}>{symbol ? formatMoneySymbol(minor, currency) : formatMoney(minor, currency)}</span>;
}

type Tone = "neutral" | "muted" | "attention" | "blocked" | "settled";

const STATE_TONE: Record<string, Tone> = {
  drafted: "muted",
  needs_evidence: "attention",
  verified: "neutral",
  awaiting_approval: "attention",
  approved: "neutral",
  blocked: "blocked",
  execution_pending: "neutral",
  sent: "neutral",
  settled: "settled",
  failed: "blocked",
  refunded: "muted",
  disputed: "attention",
  cancelled: "muted",
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink",
  muted: "bg-neutral-soft text-ink-soft",
  attention: "bg-attention-soft text-attention",
  blocked: "bg-blocked-soft text-blocked",
  settled: "bg-settled-soft text-settled",
};

/* 12px glyphs drawn in currentColor so the pill keeps one colour per state in both themes. */
const STATE_ICON: Record<string, string> = {
  blocked: "M4 4l4 4M8 4l-4 4",
  failed: "M4 4l4 4M8 4l-4 4",
  settled: "M3.25 6.25l1.9 1.9L8.9 4.2",
  sent: "M2.5 6h6M6.5 3.5 9 6l-2.5 2.5",
  execution_pending: "M2.5 6h6M6.5 3.5 9 6l-2.5 2.5",
  approved: "M3.25 6.25l1.9 1.9L8.9 4.2",
  verified: "M3.25 6.25l1.9 1.9L8.9 4.2",
  awaiting_approval: "M6 3.5V6l1.6 1.2",
  needs_evidence: "M6 3.5V6l1.6 1.2",
  disputed: "M6 3.4v3.2M6 8.4v.1",
  refunded: "M9 6H3.5M5.5 3.5 3 6l2.5 2.5",
  cancelled: "M3.5 6h5",
  drafted: "M3.5 6h5",
};

export function StatePill({ state, className = "" }: { state: string | null | undefined; className?: string }) {
  const key = state ?? "";
  const tone = STATE_TONE[key] ?? "neutral";
  const icon = STATE_ICON[key];
  const ring = tone === "attention" || key === "awaiting_approval" || key === "needs_evidence";
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-4 ${TONE_CLASS[tone]} ${className}`}>
      {icon ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className="shrink-0">
          {ring ? <circle cx="6" cy="6" r="4.4" strokeWidth="1.3" /> : null}
          <path d={icon} />
        </svg>
      ) : null}
      {stateLabel(state)}
    </span>
  );
}

/** A pill in the same tones as StatePill, for statuses that are not a request's state (payment runs). */
export function TonePill({ tone, children, className = "" }: { tone: "neutral" | "muted" | "attention" | "blocked" | "settled"; children: ReactNode; className?: string }) {
  return <span className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-4 ${TONE_CLASS[tone]} ${className}`}>{children}</span>;
}

export function StationLabel({ station, active = false }: { station: Station; active?: boolean }) {
  return <span className={`dense ${active ? "text-ink" : "text-ink-soft"}`}>{STATION_LABELS[station]}</span>;
}

export function RailTag({ rail, className = "" }: { rail: string | null | undefined; className?: string }) {
  if (!rail) return <span className={`dense text-ink-soft ${className}`}>no rail</span>;
  // Text uses the -text tokens (4.5:1 on the tint); the brand fills stay for swatches and borders.
  const tone = rail === "paypal" ? "text-paypal-text bg-paypal-soft" : rail === "stellar" ? "text-stellar-text bg-stellar-soft" : rail === "wise" ? "text-wise bg-wise-soft" : rail === "bank_file" ? "text-ink bg-rail-bank-soft" : "text-ink-soft";
  return <span className={`dense inline-flex h-5 items-center whitespace-nowrap rounded-sm px-1.5 ${tone} ${className}`}>{railLabel(rail)}</span>;
}

export function RelativeTime({ iso, className = "" }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return <span className={`text-ink-soft ${className}`}>never</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={`num whitespace-nowrap ${className}`}>
      {timeAgo(iso)}
    </time>
  );
}

export function PageHeader({ title, lede, actions, children }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lede ? <p className="mt-1 max-w-2xl text-ink-soft">{lede}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {body ? <p className="mx-auto mt-1 max-w-md text-ink-soft">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Panel({ title, aside, children, className = "", padded = true }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`panel min-w-0 ${className}`}>
      {title ? (
        <div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5 hairline">
          <h2 className="font-medium">{title}</h2>
          {aside ? <div className="dense text-ink-soft">{aside}</div> : null}
        </div>
      ) : null}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function KeyValue({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-soft">{k}</dt>
          <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TextLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`link ${className}`}>
      {children}
    </Link>
  );
}

/** Row-level link for tables: whole row clickable while remaining a real table. */
export function RowLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`relative block text-inherit no-underline after:absolute after:inset-0 after:content-[''] ${className}`}>
      {children}
    </Link>
  );
}

/** Turns "obligation obl_abc123" in a policy message into a link that reads "an earlier payment": people do not read ids. */
export function Linkified({ text }: { text: string }): ReactNode {
  const parts = text.replace(/\bobligation (obl_[a-z0-9]+)/gi, "$1").split(/(obl_[a-z0-9]+)/i);
  return parts.map((p, i) =>
    /^obl_[a-z0-9]+$/i.test(p) ? (
      <Link key={i} href={`/obligations/${p}`} className="link">
        an earlier payment
      </Link>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}
