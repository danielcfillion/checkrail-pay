/**
 * Re-check past supplier payments against Checkrail's rules, on this machine, without paying anything.
 *
 *   npm run recheck -- --inspect private/payments.private.csv [--skip N]   column names and row count, no values
 *   npm run recheck -- --example-config                                    writes private/recheck.config.json to edit
 *   npm run recheck                                                        runs private/recheck.config.json
 *   npm run recheck -- --totals                                            totals from the reviewed results file
 *
 * Every input and output lives in private/, which git ignores. The run is forced onto simulated rails and the
 * rule-based reader before any app code loads, whatever .env says: no network call, no model call, no payment.
 */

// Before anything imports config: variables already set win over .env (src/lib/config.ts).
process.env.RAIL_MODE = "mock";
process.env.AI_MODE = "mock";
process.env.STELLAR_RAIL = "mock";
process.env.ANTHROPIC_API_KEY = "";
process.env.PAYPAL_CLIENT_ID = "";
process.env.PAYPAL_CLIENT_SECRET = "";
process.env.WISE_API_TOKEN = "";
process.env.AUTOPILOT_HEARTBEAT = "off";

import fs from "node:fs";
import path from "node:path";

const PRIVATE = path.resolve("private");
const CONFIG = path.join(PRIVATE, "recheck.config.json");
const RESULTS = path.join(PRIVATE, "recheck-results.private.csv");

function insidePrivate(file: string): string {
  const full = path.resolve(file.startsWith("private/") || path.isAbsolute(file) ? file : path.join("private", file));
  if (!full.startsWith(PRIVATE + path.sep)) throw new Error(`${file} must be inside the private/ folder, which git ignores`);
  if (!fs.existsSync(full)) throw new Error(`${file} not found. Put it in ${PRIVATE}`);
  return full;
}

const EXAMPLE = {
  currency: "VND",
  country: "VN",
  payments: {
    file: "payments.private.csv",
    skipRows: 0,
    columns: { date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ", description: "Nội dung" },
    dateFormat: "DMY",
    outgoing: "any",
    referencePattern: "\\b[A-Z]{1,4}-?\\d{3,6}\\b",
  },
  jobs: {
    file: "jobs.private.csv",
    skipRows: 0,
    columns: { date: "Ngày", payee: "Đối tác", amount: "Thành tiền", reference: "Mã tour", description: "Ghi chú" },
    dateFormat: "DMY",
    matchWindowDays: 7,
  },
  payeeAliases: { "EXAMPLE SPELLING ONE": "Example Supplier" },
};

async function main() {
  const args = process.argv.slice(2);
  const { config } = await import("../src/lib/config");
  if (config.rails.mode !== "mock" || config.ai.mode !== "mock") throw new Error("Refusing to run: the re-check must use simulated rails and the rule-based reader");
  const r = await import("../src/lib/check/recheck");
  const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: cur === "VND" ? 0 : 2, minimumFractionDigits: cur === "VND" ? 0 : 2 })}`;

  if (args[0] === "--inspect") {
    const file = insidePrivate(args[1] ?? "");
    const skip = args[2] === "--skip" ? Number(args[3] ?? 0) : 0;
    const rows = r.parseCsv(fs.readFileSync(file, "utf8")).slice(skip);
    console.log(`Columns in ${path.basename(file)} (header on line ${skip + 1}):`);
    for (const h of rows[0] ?? []) console.log(`  "${h.trim()}"`);
    console.log(`${Math.max(0, rows.length - 1)} data rows. No values were printed.`);
    console.log("If the columns look wrong, the header is lower down: run again with --skip and the number of lines above it.");
    return;
  }

  if (args[0] === "--example-config") {
    fs.mkdirSync(PRIVATE, { recursive: true });
    if (fs.existsSync(CONFIG)) throw new Error(`${CONFIG} already exists; edit it instead`);
    fs.writeFileSync(CONFIG, JSON.stringify(EXAMPLE, null, 2) + "\n");
    console.log(`Wrote ${CONFIG}. Change the column names to the ones --inspect printed, then run npm run recheck.`);
    return;
  }

  if (args[0] === "--totals") {
    const { reviewed, confirmed, unreviewedFlags } = r.confirmedTotals(fs.readFileSync(insidePrivate(RESULTS), "utf8"));
    const cfg = r.validateConfig(JSON.parse(fs.readFileSync(insidePrivate(CONFIG), "utf8")));
    console.log(`Confirmed totals (only lines marked "yes" in the confirmed column count):`);
    console.log(`  Payments checked: ${confirmed.payments}, ${money(confirmed.totalMinor, cfg.currency)}`);
    console.log(`  Duplicates confirmed: ${confirmed.duplicates.count}, ${money(confirmed.duplicates.minor, cfg.currency)}`);
    console.log(`  Overcharges confirmed: ${confirmed.overcharges.count}, ${money(confirmed.overcharges.overpaidMinor, cfg.currency)} above the job record`);
    console.log(`  Would have stopped: ${money(confirmed.wouldHaveStoppedMinor, cfg.currency)}`);
    console.log(`Reviewed ${reviewed} flagged lines; ${unreviewedFlags} still to review.${unreviewedFlags ? " Finish those before publishing a number." : ""}`);
    return;
  }

  const cfg = r.validateConfig(JSON.parse(fs.readFileSync(insidePrivate(CONFIG), "utf8")));
  const pay = r.readRows(fs.readFileSync(insidePrivate(cfg.payments.file), "utf8"), cfg.payments, cfg.payeeAliases);
  const jobs = cfg.jobs ? r.readRows(fs.readFileSync(insidePrivate(cfg.jobs.file), "utf8"), cfg.jobs, cfg.payeeAliases) : { rows: [], skipped: [] };
  console.log(`Read ${pay.rows.length} payments${cfg.jobs ? ` and ${jobs.rows.length} job records` : " (no job records file: amounts cannot be checked against jobs)"}.`);
  for (const s of [...pay.skipped, ...jobs.skipped].slice(0, 10)) console.log(`  skipped row ${s.row}: ${s.problem}`);
  const rows = await r.runRecheck({ config: cfg, payments: pay.rows, jobs: jobs.rows });
  fs.writeFileSync(RESULTS, r.resultsCsv(rows));
  const t = r.totals(rows);
  console.log("");
  console.log(`Payments checked: ${t.payments}, ${money(t.totalMinor, cfg.currency)}`);
  console.log(`Flagged as duplicates: ${t.duplicates.count}, ${money(t.duplicates.minor, cfg.currency)}`);
  console.log(`Flagged as above the job record: ${t.overcharges.count}, ${money(t.overcharges.overpaidMinor, cfg.currency)} over`);
  console.log(`Other blocks: ${t.blockedOther}. Needs a person's look: ${t.needsALook.count}${t.needsALook.topReasons.length ? ` (${t.needsALook.topReasons.map((x) => `${x.rule} ${x.count}`).join(", ")})` : ""}. Clean: ${t.clean}.`);
  console.log("");
  console.log(`Details: ${RESULTS}`);
  console.log('These are flags, not findings. Open the file, read each duplicate and overcharge line, write yes or no in "confirmed",');
  console.log("then run npm run recheck -- --totals. Only confirmed totals go in the video or Devpost, and never the supplier names.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
