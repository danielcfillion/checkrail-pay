/**
 * Demo FX rates for the seeded history only. Past demo payments were made through the simulated rails, which quote one
 * fixed mid rate per corridor, so every past payment used the same rate. Real rates move: this small table gives a
 * mid rate per week, near the corridor's level, so history reads like history.
 *
 * These are demo rates, not market data. Every settlement that uses one says so in its note, and the bookkeeper pack
 * marks the rate "demo". Live rails never read this table: they record the rate the provider reports.
 */

/** Monday of each week, then USD to PHP and USD to VND mid rates for that week. */
const WEEKS: Array<[string, number, number]> = [
  ["2026-06-29", 61.84, 25_215],
  ["2026-07-06", 61.97, 25_240],
  ["2026-07-13", 62.21, 25_262],
  ["2026-07-20", 62.08, 25_251],
  ["2026-07-27", 62.35, 25_288],
  ["2026-08-03", 62.52, 25_305],
  ["2026-08-10", 62.29, 25_297],
  ["2026-08-17", 62.11, 25_276],
  ["2026-08-24", 62.40, 25_318],
  ["2026-08-31", 62.66, 25_342],
  ["2026-09-07", 62.81, 25_361],
  ["2026-09-14", 62.57, 25_379],
  ["2026-09-21", 62.73, 25_396],
  ["2026-09-28", 62.94, 25_384],
  ["2026-10-05", 62.69, 25_402],
  ["2026-10-12", 62.48, 25_391],
  ["2026-10-19", 62.62, 25_407],
  ["2026-10-26", 62.75, 25_418],
  ["2026-11-02", 62.61, 25_400],
];

export const DEMO_RATE_NOTE = "Demo rate: this past payment's FX rate comes from Checkrail's table of demo rates for its week (near real levels), not from a provider.";

/** The demo mid rate for a currency on a date (YYYY-MM-DD), or null for a currency the table does not cover. */
export function demoMidRate(currency: string, date: string): number | null {
  const col = currency === "PHP" ? 1 : currency === "VND" ? 2 : 0;
  if (!col) return null;
  let row = WEEKS[0];
  for (const w of WEEKS) if (w[0] <= date) row = w;
  return row[col] as number;
}
