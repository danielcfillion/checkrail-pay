/**
 * Render the app's main routes from a running server and fail if any page says "obligation" or shows an internal id
 * (DS2-5). People read "payment request"; code and URLs keep `obligation`.
 *
 *   npx tsx scripts/check-copy.ts http://localhost:3402 judge:demo-pass
 */
import { crawlCopy } from "./check-copy-lib";

const base = process.argv[2] ?? process.env.CHECK_COPY_BASE ?? "http://localhost:3000";
const auth = process.argv[3] ?? process.env.CHECK_COPY_AUTH ?? "judge:demo-pass";

crawlCopy(base, auth).then((findings) => {
  for (const f of findings) console.log(`${f.severity === "error" ? "FAIL" : "warn"}  ${f.path}  [${f.word}]  ${f.context}`);
  const errors = findings.filter((f) => f.severity === "error").length;
  console.log(errors ? `${errors} page(s) say obligation.` : `No page says obligation. ${findings.length} internal id warning(s).`);
  process.exit(errors ? 1 : 0);
});
