import Link from "next/link";
import type { ReactNode } from "react";
import { formatMoney, formatMoneySymbol, railLabel, stateLabel, timeAgo, formatDateTime } from "@/lib/format";
import { STATION_LABELS, type Station } from "./dueline-model";

/* Small, server-safe presentational pieces. */

export function Money({ minor, currency, symbol = false, className = "" }: { minor: number | null | undefined; currency: string | null | undefined; symbol?: boolean; className?: string }) {
  if (minor === null || minor === undefined) return <span className={`num text-ink-soft ${className}`}>no amount</span>;
  return <span className={`num ${className}`}>{symbol ? formatMoneySymbol(minor, currency) : formatMoney(minor, currency)}</span>;
}

const STATE_TONE: Record<string, string> = {
  drafted: "text-ink-soft",
  needs_evidence: "text-attention",
  verified: "text-ink",
  awaiting_approval: "text-attention",
  approved: "text-ink",
  blocked: "text-blocked",
  execution_pending: "text-ink",
  sent: "text-ink",
  settled: "text-settled",
  failed: "text-blocked",
  refunded: "text-ink-soft",
  disputed: "text-attention",
  cancelled: "text-ink-soft",
};

export function StatePill({ state, className = "" }: { state: string | null | undefined; className?: string }) {
  const tone = STATE_TONE[state ?? ""] ?? "text-ink";
  return <span className={`dense inline-flex items-center whitespace-nowrap ${tone} ${className}`}>{stateLabel(state)}</span>;
}

export function StationLabel({ station, active = false }: { station: Station; active?: boolean }) {
  return <span className={`dense ${active ? "text-ink" : "text-ink-soft"}`}>{STATION_LABELS[station]}</span>;
}

export function RailTag({ rail, className = "" }: { rail: string | null | undefined; className?: string }) {
  if (!rail) return <span className={`dense text-ink-soft ${className}`}>no rail</span>;
  const tone = rail === "paypal" ? "text-paypal bg-paypal-soft" : rail === "stellar" ? "text-stellar bg-stellar-soft" : "text-ink-soft";
  return <span className={`dense inline-flex h-5 items-center rounded-sm px-1.5 ${tone} ${className}`}>{railLabel(rail)}</span>;
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
          <dd className="min-w-0 break-words">{v}</dd>
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

/** Turns "obligation obl_xxx (settled)" in a policy message into a link to that obligation. */
export function Linkified({ text }: { text: string }): ReactNode {
  const parts = text.split(/(obl_[a-z0-9]+)/i);
  return parts.map((p, i) =>
    /^obl_[a-z0-9]+$/i.test(p) ? (
      <Link key={i} href={`/obligations/${p}`} className="link num">
        {p}
      </Link>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}
