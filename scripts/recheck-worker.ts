/*
 * The in-app re-check runs here, in its own Node process, never inside the web server.
 *
 * runRecheck swaps the global clock for each past payment it judges. Inside the server that would hand every other
 * request (a payment being approved, an autopilot release, an audit row) a date months in the past for as long as the
 * re-check runs. A separate process has its own clock and its own config, so nothing in the server is touched.
 *
 * Input: one JSON RecheckInput (without db) on stdin. Output: the results as JSON after a marker line on stdout.
 * The parent starts it with AI_MODE=mock and RAIL_MODE=mock and no keys, so it reads with the rules only and can
 * never reach a rail or a model.
 */
import { runRecheck, type RecheckInput } from "../src/lib/check/recheck";

export const RESULT_MARKER = "@@CHECKRAIL_RECHECK_RESULT@@";

async function main() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Omit<RecheckInput, "db">;
  const rows = await runRecheck(input);
  process.stdout.write(`\n${RESULT_MARKER}\n${JSON.stringify(rows)}\n`);
}

main().catch((e) => {
  process.stderr.write(String((e as Error)?.message ?? e).slice(0, 500));
  process.exit(1);
});
