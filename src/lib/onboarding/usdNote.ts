import type { DashboardData } from "./dashboard";
import { demoMidRate } from "../demo/fxRates";
import { formatMoney } from "../format";

/**
 * One line under the dashboard header for a business whose history is in a currency most readers do not think in
 * (dong, pesos): the two headline totals in US dollars, at the demo rate. Studio's own tiles stay in the currency of the
 * payments; rows are never converted, so this is a note beside them, not a figure inside them. Null when the money is in
 * one currency we have no demo rate for, in dollars already, or in several currencies.
 */
export function usdEquivalentNote(data: Pick<DashboardData, "money_stopped">, today: string): string | null {
  const currencies = [...new Set(data.money_stopped.map((r) => r.currency))];
  if (currencies.length !== 1 || currencies[0] === "USD") return null;
  const currency = currencies[0];
  const rate = demoMidRate(currency, today);
  if (!rate) return null;
  const sum = (key: "stopped_minor" | "held_minor") => data.money_stopped.reduce((a, r) => a + r[key], 0);
  const usd = (minor: number) => formatMoney(Math.round(minor / rate / 100) * 100, "USD", { code: true }).replace(/\.00$/, "");
  return `Shown in ${currency}. At Checkrail's demo rate of about ${Math.round(rate).toLocaleString("en-US")} ${currency} to USD, money stopped is about ${usd(sum("stopped_minor"))} and money that waited for a person is about ${usd(sum("held_minor"))}.`;
}
