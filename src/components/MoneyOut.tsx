"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PaymentPoint } from "@/lib/queries";
import { formatMoney, formatMoneySymbol, pluralise } from "@/lib/format";

type Range = 7 | 30 | 90;
type Bucket = { key: string; label: string; long: string; start: number; end: number; paypal: number; stellar: number; bank: number; fee: number; items: PaymentPoint[] };

const RAILS = [
  { key: "paypal" as const, name: "PayPal", fill: "var(--chart-paypal)" },
  { key: "stellar" as const, name: "Stellar", fill: "var(--chart-stellar)" },
  { key: "bank" as const, name: "Bank (Wise, file)", fill: "var(--chart-bank)" },
];
const railKey = (rail: string): "paypal" | "stellar" | "bank" => (rail === "paypal" ? "paypal" : rail === "stellar" ? "stellar" : "bank");
const sumRails = (b: { paypal: number; stellar: number; bank: number }) => b.paypal + b.stellar + b.bank;
const DAY = 86_400_000;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 52 };

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function buckets(points: PaymentPoint[], range: Range, now: number): Bucket[] {
  const step = range === 90 ? 7 : 1;
  const count = range === 90 ? 13 : range;
  const lastStart = startOfDay(now) - (step - 1) * DAY;
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = lastStart - i * step * DAY;
    const end = start + step * DAY;
    out.push({ key: String(start), label: fmtDay(start), long: step === 1 ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end - DAY)}`, start, end, paypal: 0, stellar: 0, bank: 0, fee: 0, items: [] });
  }
  for (const p of points) {
    const t = new Date(p.settledAt).getTime();
    const b = out.find((x) => t >= x.start && t < x.end);
    if (!b) continue;
    b[railKey(p.rail)] += p.grossMinor;
    b.fee += p.feeMinor;
    b.items.push(p);
  }
  return out;
}

/** Clean axis ceiling and ticks: 0 / 250 / 500 style steps in whole currency units. */
function axis(maxMinor: number): number[] {
  const max = Math.max(maxMinor / 100, 1);
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 100));
  return ticks;
}

/**
 * Money out over time, by rail. The range control scopes everything in this section: the figures,
 * the chart and the payment table. Hover or focus a column for its numbers; select it to narrow the table.
 */
export function MoneyOut({ points, currency }: { points: PaymentPoint[]; currency: string }) {
  const [range, setRange] = useState<Range>(30);
  const [now, setNow] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setNow(Date.now()), [points]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const bs = useMemo(() => (now === null ? [] : buckets(points, range, now)), [points, range, now]);
  const inRange = useMemo(() => bs.flatMap((b) => b.items), [bs]);
  const total = inRange.reduce((a, p) => a + p.grossMinor, 0);
  const fees = inRange.reduce((a, p) => a + p.feeMinor, 0);
  const byAgent = inRange.filter((p) => p.by === "agent");
  const railTotal = (k: "paypal" | "stellar" | "bank") => bs.reduce((a, b) => a + b[k], 0);

  const ticks = axis(Math.max(...bs.map((b) => sumRails(b)), 0));
  const top = ticks[ticks.length - 1] || 1;
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const band = bs.length ? innerW / bs.length : innerW;
  const barW = Math.min(24, Math.max(4, band - 6));
  const y = (minor: number) => PAD.top + innerH - (minor / top) * innerH;
  const labelEvery = Math.max(1, Math.ceil(bs.length / Math.max(2, Math.floor(innerW / 64))));

  const active = bs.find((b) => b.key === hover) ?? null;
  const selected = bs.find((b) => b.key === picked) ?? null;
  const rows = (selected ? selected.items : inRange).slice().sort((a, b) => b.settledAt.localeCompare(a.settledAt));
  const activeIndex = active ? bs.indexOf(active) : -1;
  // The tooltip sits beside the hovered column, never on top of it: right of it in the left half, left of it in the right half.
  const TIP_W = 176;
  const colCentre = PAD.left + band * (activeIndex + 0.5);
  const tipLeft = !active ? 0 : colCentre < width / 2 ? Math.min(colCentre + Math.max(band, barW) / 2 + 10, width - TIP_W) : Math.max(colCentre - Math.max(band, barW) / 2 - 10 - TIP_W, 0);

  return (
    <section aria-label="Money out">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Money out</h2>
        <div role="group" aria-label="Date range" className="inline-flex overflow-hidden rounded border hairline">
          {([7, 30, 90] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => {
                setRange(r);
                setPicked(null);
              }}
              className={`h-7 px-3 text-xs font-medium ${range === r ? "bg-[color:var(--primary)] text-[color:var(--primary-ink)]" : "bg-sheet text-ink-soft hover:text-ink"}`}
            >
              Last {r} days
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <dl className="grid grid-cols-2 gap-y-3 border-b px-4 py-3 hairline sm:grid-cols-4">
          <Stat label="Paid" value={formatMoneySymbol(total, currency)} note={pluralise(inRange.length, "payment")} />
          <Stat label="Fees" value={formatMoneySymbol(fees, currency)} note={total ? `${((fees / total) * 100).toFixed(1)}% of paid` : "no payments"} />
          <Stat label="Sent by autopilot" value={`${byAgent.length} of ${inRange.length}`} note={formatMoneySymbol(byAgent.reduce((a, p) => a + p.grossMinor, 0), currency)} />
          <div>
            <dt className="dense text-ink-soft">By rail</dt>
            {RAILS.map((r) => (
              <dd key={r.key} className="mt-1 flex items-center gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.fill }} />
                <span>{r.name}</span>
                <span className="num ml-auto">{formatMoneySymbol(railTotal(r.key), currency)}</span>
              </dd>
            ))}
          </div>
        </dl>

        <div ref={wrap} className="relative px-2 pb-1 pt-2">
          {now === null ? (
            <div style={{ height: H }} />
          ) : (
            <svg width={width} height={H} role="group" aria-label={`Payments settled per ${range === 90 ? "week" : "day"}, last ${range} days, by rail`} onPointerLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
                  <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-soft)" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {(t / 100).toLocaleString("en-US")}
                  </text>
                </g>
              ))}
              {bs.map((b, i) => {
                const cx = PAD.left + band * (i + 0.5);
                const x = cx - barW / 2;
                const on = hover === b.key || picked === b.key;
                const segs = RAILS.map((r) => ({ ...r, v: b[r.key] })).filter((s) => s.v > 0);
                let base = PAD.top + innerH;
                return (
                  <g key={b.key}>
                    <rect
                      x={PAD.left + band * i}
                      y={PAD.top}
                      width={band}
                      height={innerH + PAD.bottom}
                      fill={on ? "var(--rule)" : "transparent"}
                      opacity={on ? 0.45 : 1}
                      tabIndex={0}
                      role="button"
                      aria-pressed={picked === b.key}
                      aria-label={`${b.long}: ${b.items.length ? `${formatMoney(sumRails(b), currency)} in ${pluralise(b.items.length, "payment")}. PayPal ${formatMoney(b.paypal, currency)}, Stellar ${formatMoney(b.stellar, currency)}${b.bank ? `, bank ${formatMoney(b.bank, currency)}` : ""}` : "no payments"}`}
                      style={{ cursor: b.items.length ? "pointer" : "default", outline: "none" }}
                      onPointerMove={() => setHover(b.key)}
                      onFocus={() => setHover(b.key)}
                      onBlur={() => setHover(null)}
                      onClick={() => setPicked(picked === b.key || !b.items.length ? null : b.key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setPicked(picked === b.key || !b.items.length ? null : b.key);
                        }
                      }}
                    />
                    {segs.map((s, si) => {
                      const h = Math.max(2, (s.v / top) * innerH);
                      const isTop = si === segs.length - 1;
                      const gap = si === 0 ? 0 : 2; // surface gap between stacked segments
                      const yTop = base - h;
                      const hh = Math.max(1, h - gap);
                      const r = isTop ? Math.min(4, hh, barW / 2) : 0;
                      const d = `M${x},${yTop + hh} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + hh} Z`;
                      base = yTop;
                      return <path key={s.key} d={d} fill={s.fill} pointerEvents="none" />;
                    })}
                    {i % labelEvery === 0 ? (
                      <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--ink-soft)" pointerEvents="none">
                        {b.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} stroke="var(--rule-strong)" strokeWidth={1} />
            </svg>
          )}
          {active ? (
            <div className="panel pointer-events-none absolute z-10 w-44 px-3 py-2 text-xs" style={{ left: tipLeft, top: 8 }} role="status">
              <p className="text-ink-soft">{active.long}</p>
              {active.items.length ? (
                <>
                  <p className="num mt-0.5 text-base font-semibold">{formatMoneySymbol(sumRails(active), currency)}</p>
                  {RAILS.map((r) => (
                    <p key={r.key} className="mt-1 flex items-center gap-2">
                      <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: r.fill }} />
                      <span className="num font-medium">{formatMoneySymbol(active[r.key], currency)}</span>
                      <span className="text-ink-soft">{r.name}</span>
                    </p>
                  ))}
                  <p className="mt-1 text-ink-soft">
                    {pluralise(active.items.length, "payment")}, fees <span className="num">{formatMoneySymbol(active.fee, currency)}</span>
                  </p>
                </>
              ) : (
                <p className="mt-0.5">No payments</p>
              )}
            </div>
          ) : null}
        </div>

        <div className="border-t hairline">
          <div className="flex items-baseline justify-between gap-3 px-4 py-2">
            <p className="dense text-ink-soft">{selected ? `Payments, ${selected.long}` : `Payments, last ${range} days`}</p>
            {selected ? (
              <button type="button" className="link text-xs" onClick={() => setPicked(null)}>
                Show all
              </button>
            ) : (
              <span className="text-xs text-ink-soft">Select a column to narrow this list</span>
            )}
          </div>
          {rows.length ? (
            <div className="max-h-72 overflow-auto">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Settled</th>
                    <th>Paid to</th>
                    <th>Rail</th>
                    <th>Sent by</th>
                    <th className="r">Fee</th>
                    <th className="r">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} className="row-link">
                      <td className="num whitespace-nowrap text-ink-soft">{fmtDay(new Date(p.settledAt).getTime())}</td>
                      <td className="whitespace-nowrap">
                        <Link href={`/obligations/${p.id}`} className="font-medium hover:underline">
                          {p.vendorName ?? "Unknown vendor"}
                        </Link>{" "}
                        <span className="num text-ink-soft">{p.sourceRef ?? ""}</span>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RAILS.find((r) => r.key === railKey(p.rail))!.fill }} />
                          {p.rail === "paypal" ? "PayPal" : p.rail === "stellar" ? "Stellar" : p.rail === "wise" ? "Wise" : "Bank file"}
                        </span>
                      </td>
                      <td className="text-ink-soft">{p.by === "agent" ? "Autopilot" : p.by === "person" ? "A person" : "Imported"}</td>
                      <td className="r num text-ink-soft">{formatMoney(p.paidFeeMinor, p.paidCurrency, { code: false })}</td>
                      <td className="r num font-medium">{formatMoney(p.paidMinor, p.paidCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 pb-5 pt-2 text-center text-ink-soft">No payments settled in this period.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <dt className="dense text-ink-soft">{label}</dt>
      <dd className="wide mt-1 text-xl">{value}</dd>
      <dd className="num text-xs text-ink-soft">{note}</dd>
    </div>
  );
}
