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

/** Both rails side by side. The delivered amount is the largest figure after the obligation amount. */
export function RouteCompare({ quotes, selectedRail, routeReason }: { quotes: Quote[]; selectedRail: string | null; routeReason: string | null }) {
  const order = ["paypal", "stellar"];
  const sorted = [...quotes].sort((a, b) => order.indexOf(a.rail) - order.indexOf(b.rail));
  if (!sorted.length) return <p className="text-ink-soft">No route quotes yet. Quotes are produced once the vendor and amount are known.</p>;
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sorted.map((q) => {
          const selected = q.rail === selectedRail;
          const colour = q.rail === "paypal" ? "var(--paypal)" : "var(--stellar)";
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
      {routeReason ? (
        <p className="mt-3 border-t pt-2 text-xs hairline">
          <span className="text-ink-soft">Router: </span>
          {routeReason}
        </p>
      ) : null}
    </div>
  );
}
