import { senderOutlayMinor } from "@/lib/domain/routing";
import type { Rail } from "@/lib/domain/types";
import { lowerFirst, routeLine } from "./route-note";
import { formatFxRate, formatMoney, formatMoneySymbol, humaniseEta, railLabel } from "@/lib/format";

export type Quote = {
  rail: string;
  available: boolean;
  unavailableReason: string | null;
  sendAmountMinor: number | null;
  sendCurrency: string | null;
  feeMinor: number | null;
  fxRate: string | null;
  receiveAmountMinor: number | null;
  receiveCurrency: string | null;
  etaSeconds: number | null;
  provider: string | null;
  explanation: string | null;
};

/** The rails side by side. The delivered amount is the largest figure; "Sender pays" puts them on the same footing (every fee is paid on top, so the recipient gets the full amount). */
export function RouteCompare({ quotes, selectedRail, routeReason, ready = false }: { quotes: Quote[]; selectedRail: string | null; routeReason: string | null; ready?: boolean }) {
  const line = routeLine(routeReason, selectedRail, ready, railLabel);
  const order = ["paypal", "stellar", "wise", "bank_file"];
  // Cards for every rail that can pay this, and for PayPal and Stellar either way (their reasons are worth seeing);
  // bank rails that cannot serve it are one line underneath.
  const all = [...quotes].sort((a, b) => order.indexOf(a.rail) - order.indexOf(b.rail));
  const sorted = all.filter((q) => q.available || q.rail === "paypal" || q.rail === "stellar");
  const quiet = all.filter((q) => !sorted.includes(q));
  if (!all.length) return <p className="text-ink-soft">No route quotes yet. Quotes are produced once the vendor and amount are known.</p>;
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sorted.map((q) => {
          const selected = q.rail === selectedRail;
          const colour = q.rail === "paypal" ? "var(--paypal)" : q.rail === "stellar" ? "var(--stellar)" : q.rail === "wise" ? "var(--wise)" : "var(--ink)";
          return (
            <article key={q.rail} className="rounded border p-3" style={{ borderColor: selected ? colour : "var(--rule)", borderWidth: selected ? 1.5 : 1 }} aria-label={`${railLabel(q.rail)} quote${selected ? ", selected" : ""}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="dense" style={{ color: colour }}>
                  {railLabel(q.rail)}
                </span>
                {selected ? <span className="dense text-ink">selected</span> : null}
              </div>
              {q.available ? (
                <>
                  <p className="wide num mt-2 text-xl leading-7">{formatMoneySymbol(q.receiveAmountMinor, q.receiveCurrency)}</p>
                  <p className="text-xs text-ink-soft">delivered to the recipient</p>
                  <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-ink-soft">Fee</dt>
                    <dd>{formatMoney(q.feeMinor, q.sendCurrency)}</dd>
                    <dt className="text-ink-soft">Sender pays</dt>
                    <dd>{formatMoney(senderOutlayMinor({ rail: q.rail as Rail, sendAmountMinor: q.sendAmountMinor ?? 0, feeMinor: q.feeMinor ?? 0 }), q.sendCurrency)}</dd>
                    <dt className="text-ink-soft">Rate</dt>
                    <dd>{q.receiveCurrency === q.sendCurrency ? "no FX" : `1 ${q.sendCurrency} = ${formatFxRate(q.fxRate)} ${q.receiveCurrency}`}</dd>
                    <dt className="text-ink-soft">Arrives</dt>
                    <dd>{humaniseEta(q.etaSeconds) || "unknown"}</dd>
                    <dt className="text-ink-soft">Via</dt>
                    <dd className="font-sans" style={{ fontVariantNumeric: "normal" }}>
                      {q.provider}
                    </dd>
                  </dl>
                  {q.explanation ? <p className="mt-3 text-xs leading-4 text-ink-soft">{q.explanation}</p> : null}
                </>
              ) : (
                <>
                  <p className="mt-2 text-lg font-medium text-ink-soft">Unavailable</p>
                  <p className="mt-1 text-xs leading-4 text-ink-soft">{q.unavailableReason ?? "This rail cannot serve the corridor."}</p>
                </>
              )}
            </article>
          );
        })}
      </div>
      {quiet.length || line ? (
        <div className="mt-3 border-t pt-2 text-xs hairline">
          {line ? <p className={ready ? "font-medium" : undefined}>{line}</p> : null}
          {quiet.length ? <p className={`text-ink-soft ${line ? "mt-1" : ""}`}>{quiet.map((q) => `${railLabel(q.rail)} cannot pay this: ${lowerFirst(q.unavailableReason ?? "unavailable")}`).join(". ")}.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

