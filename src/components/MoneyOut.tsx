"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PaymentPoint } from "@/lib/queries";
import { formatMoney, formatMoneySymbol, pluralise } from "@/lib/format";
import { RailTag } from "./ui";
import { axis, axisLabel, buckets, chooseStep, fmtDay, H, PAD, PAD_PHONE, railKey, sumRails, type Bucket, type Range, type Step } from "./moneyout-model";

const RAILS = [
  { key: "paypal" as const, name: "PayPal", fill: "var(--chart-paypal)" },
  { key: "stellar" as const, name: "Stellar", fill: "var(--chart-stellar)" },
  // Neutral slate, never the settled green: bank is a rail, not a state.
  { key: "bank" as const, name: "Bank (Wise, file)", fill: "var(--rail-bank, #5B6B7C)" },
];
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
  /** Index of the one column in the Tab order (roving tabindex). */
  const [cursor, setCursor] = useState<number | null>(null);
  const [kbFocus, setKbFocus] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const cols = useRef<Array<SVGRectElement | null>>([]);

  useEffect(() => setNow(Date.now()), [points]);
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const on = () => setCoarse(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(280, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const phone = width < 600;
  const pad = phone ? PAD_PHONE : PAD;
  const innerW = width - pad.left - pad.right;
  // 44px columns are a touch requirement: applied on phones and coarse pointers, not to a mouse on a wide screen.
  const step: Step = now === null ? 1 : chooseStep(points, range, now, phone || coarse ? innerW : Infinity);
  const bs = useMemo(() => (now === null ? [] : buckets(points, range, now, step)), [points, range, now, step]);
  const inRange = useMemo(() => bs.flatMap((b) => b.items), [bs]);
  const total = inRange.reduce((a, p) => a + p.grossMinor, 0);
  const fees = inRange.reduce((a, p) => a + p.feeMinor, 0);
  const byAgent = inRange.filter((p) => p.by === "agent");
  const railTotal = (k: "paypal" | "stellar" | "bank") => bs.reduce((a, b) => a + b[k], 0);

  const ticks = axis(Math.max(...bs.map((b) => sumRails(b)), 0));
  const top = ticks[ticks.length - 1] || 1;
  const innerH = H - pad.top - pad.bottom;
  const band = bs.length ? innerW / bs.length : innerW;
  // At least 60% of the band, so the bars carry the chart rather than the gaps; never wider than the band less a 2px gap.
  const barW = Math.max(4, Math.min(band - 2, Math.round(band * 0.6)));
  const y = (minor: number) => pad.top + innerH - (minor / top) * innerH;
  const labelEvery = Math.max(1, Math.ceil(bs.length / Math.max(2, Math.floor(innerW / 64))));

  const active = bs.find((b) => b.key === hover) ?? null;
  const selected = bs.find((b) => b.key === picked) ?? null;
  const rows = (selected ? selected.items : inRange).slice().sort((a, b) => b.settledAt.localeCompare(a.settledAt));
  const activeIndex = active ? bs.indexOf(active) : -1;
  // The tooltip sits beside the hovered column, never on top of it: right of it in the left half, left of it in the right half.
  const TIP_W = 176;
  const colCentre = pad.left + band * (activeIndex + 0.5);
  const tipLeft = !active ? 0 : colCentre < width / 2 ? Math.min(colCentre + Math.max(band, barW) / 2 + 10, width - TIP_W) : Math.max(colCentre - Math.max(band, barW) / 2 - 10 - TIP_W, 0);

  // The column in the Tab order: the one last moved to, else the selected one, else the latest with payments.
  const lastWithPayments = bs.reduce((a, b, i) => (b.items.length ? i : a), bs.length - 1);
  const tabIndexAt = Math.min(cursor ?? (selected ? bs.indexOf(selected) : lastWithPayments), Math.max(0, bs.length - 1));
  const moveTo = (i: number) => {
    const n = Math.max(0, Math.min(bs.length - 1, i));
    setCursor(n);
    setHover(bs[n]?.key ?? null);
    cols.current[n]?.focus();
  };
  const toggle = (b: Bucket) => setPicked(picked === b.key || !b.items.length ? null : b.key);
  const unit = step === 1 ? "day" : step === 7 ? "week" : "fortnight";

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
                setCursor(null);
              }}
              className={`h-7 px-3 text-xs font-medium max-sm:h-11 ${range === r ? "bg-[color:var(--primary)] text-[color:var(--primary-ink)]" : "bg-sheet text-ink-soft hover:text-ink"}`}
            >
              Last {r} days
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <dl className="grid grid-cols-2 gap-y-3 border-b px-4 py-3 hairline sm:grid-cols-4">
          <Stat label="Paid" value={formatMoneySymbol(total, currency)} note={pluralise(inRange.length, "payment")} zero={total === 0} />
          <Stat label="Fees" value={formatMoneySymbol(fees, currency)} note={total ? `${((fees / total) * 100).toFixed(1)}% of paid` : "no payments"} zero={fees === 0} />
          <Stat label="Sent by autopilot" value={`${byAgent.length} of ${inRange.length}`} note={formatMoneySymbol(byAgent.reduce((a, p) => a + p.grossMinor, 0), currency)} zero={byAgent.length === 0} />
          <div>
            <dt className="dense text-ink-soft">By rail</dt>
            {RAILS.map((r) => (
              <dd key={r.key} className="mt-1 flex items-center gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.fill }} />
                <span>{r.name}</span>
                <span className={`num ml-auto ${railTotal(r.key) ? "" : "text-ink-soft"}`}>{formatMoneySymbol(railTotal(r.key), currency)}</span>
              </dd>
            ))}
          </div>
        </dl>

        <div ref={wrap} className="relative px-2 pb-1 pt-2">
          {now === null ? (
            <div style={{ height: H }} />
          ) : (
            <svg
              width={width}
              height={H}
              role="group"
              aria-label={`Payments settled per ${unit}, last ${range} days, by rail, in ${currency}. One Tab stop: Left and Right move between columns, Home and End jump to the ends, Enter narrows the list, Escape shows all.`}
              onPointerLeave={() => setHover(null)}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth={1} />
                  <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--ink-soft)" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {axisLabel(t, currency)}
                  </text>
                </g>
              ))}
              {bs.map((b, i) => {
                const cx = pad.left + band * (i + 0.5);
                const x = cx - barW / 2;
                const on = hover === b.key || picked === b.key;
                const focusRing = kbFocus && i === tabIndexAt;
                const segs = RAILS.map((r) => ({ ...r, v: b[r.key] })).filter((s) => s.v > 0);
                let base = pad.top + innerH;
                return (
                  <g key={b.key}>
                    <rect
                      ref={(el) => {
                        cols.current[i] = el;
                      }}
                      x={pad.left + band * i}
                      y={pad.top}
                      width={band}
                      height={innerH + pad.bottom}
                      fill={on ? "color-mix(in srgb, var(--rule) 45%, transparent)" : "transparent"}
                      stroke={focusRing ? "var(--focus)" : "none"}
                      strokeWidth={focusRing ? 2 : 0}
                      tabIndex={i === tabIndexAt ? 0 : -1}
                      role="button"
                      aria-pressed={picked === b.key}
                      aria-label={`${b.long}: ${b.items.length ? `${formatMoney(sumRails(b), currency)} in ${pluralise(b.items.length, "payment")}. PayPal ${formatMoney(b.paypal, currency)}, Stellar ${formatMoney(b.stellar, currency)}${b.bank ? `, bank ${formatMoney(b.bank, currency)}` : ""}` : "no payments"}`}
                      style={{ cursor: b.items.length ? "pointer" : "default", outline: "none" }}
                      onPointerMove={() => setHover(b.key)}
                      onFocus={() => {
                        setHover(b.key);
                        setCursor(i);
                        setKbFocus(true);
                      }}
                      onBlur={() => {
                        setHover(null);
                        setKbFocus(false);
                      }}
                      onPointerDown={() => setKbFocus(false)}
                      onClick={() => {
                        setCursor(i);
                        toggle(b);
                      }}
                      onKeyDown={(e) => {
                        const go: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bs.length - 1 };
                        if (e.key in go) {
                          e.preventDefault();
                          moveTo(go[e.key]);
                        } else if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(b);
                        } else if (e.key === "Escape" && picked) {
                          e.preventDefault();
                          setPicked(null);
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
              <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="var(--rule-strong)" strokeWidth={1} />
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
              <button type="button" className="link text-xs max-sm:-my-3 max-sm:min-h-11 max-sm:px-2" onClick={() => setPicked(null)}>
                Show all
              </button>
            ) : (
              <span className="text-xs text-ink-soft">{phone ? "Tap a column to narrow this list" : "Select a column to narrow this list"}</span>
            )}
          </div>
          {rows.length ? (
            <div className="max-h-72 overflow-auto">
              {/* phone: two-line rows, the whole row is the link, the amount always shows */}
              <ul className="divide-y hairline border-t sm:hidden">
                {rows.map((p) => (
                  <li key={p.id}>
                    <Link href={`/obligations/${p.id}`} className="block min-h-11 px-4 py-2.5 active:bg-paper">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-medium">{p.vendorName ?? "Unknown vendor"}</span>
                        <span className="num shrink-0 whitespace-nowrap font-medium">{formatMoney(p.paidMinor, p.paidCurrency)}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
                        <span className="num min-w-0 truncate">{p.sourceRef ?? "no reference"}</span>
                        <span className="num shrink-0 whitespace-nowrap">{fmtDay(new Date(p.settledAt).getTime())}</span>
                        <span className="shrink-0 whitespace-nowrap">{byLabel(p.by)}</span>
                        <RailTag rail={p.rail} className="ml-auto shrink-0" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <table className="ledger max-sm:hidden">
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
                    <tr key={p.id} className="row-link relative">
                      <td className="num whitespace-nowrap text-ink-soft">{fmtDay(new Date(p.settledAt).getTime())}</td>
                      <td className="whitespace-nowrap">
                        <Link href={`/obligations/${p.id}`} className="font-medium after:absolute after:inset-0 after:content-[''] hover:underline">
                          {p.vendorName ?? "Unknown vendor"}
                        </Link>{" "}
                        <span className="num whitespace-nowrap text-ink-soft">{p.sourceRef ?? ""}</span>
                      </td>
                      <td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RAILS.find((r) => r.key === railKey(p.rail))!.fill }} />
                          {p.rail === "paypal" ? "PayPal" : p.rail === "stellar" ? "Stellar" : p.rail === "wise" ? "Wise" : "Bank file"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-ink-soft">{byLabel(p.by)}</td>
                      <td className="r num whitespace-nowrap text-ink-soft">{formatMoney(p.paidFeeMinor, p.paidCurrency, { code: false })}</td>
                      <td className="r num whitespace-nowrap font-medium">{formatMoney(p.paidMinor, p.paidCurrency)}</td>
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

const byLabel = (by: PaymentPoint["by"]) => (by === "agent" ? "Autopilot" : by === "person" ? "A person" : "Imported");

/** A zero figure is set in ink-soft, so "nothing" never carries the same weight as real money. */
function Stat({ label, value, note, zero = false }: { label: string; value: string; note: string; zero?: boolean }) {
  return (
    <div>
      <dt className="dense text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1 text-xl ${zero ? "text-ink-soft" : ""}`}>{value}</dd>
      <dd className="num text-xs text-ink-soft">{note}</dd>
    </div>
  );
}
