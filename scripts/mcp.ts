/**
 * Checkrail's MCP server over stdio, for an agent running on the same machine as the app (Claude Desktop, Claude Code).
 *
 *   npm run -s mcp                     check_payment, lookup_payee, explain_rule
 *   npm run -s mcp -- --allow-requests  also request_payment and payment_status
 *   npm run -s mcp -- --allow-requests --attest   what this agent attaches counts as the business's own records
 *   npm run -s mcp -- --supplier=ven_phuong        a supplier's own agent, for that one supplier (accept_offer, dispute_offer)
 *
 * It opens the same database as the app (DATABASE_PATH, default ./data/checkrail-pay.sqlite) and follows .env for the
 * rails and the reader, so in live mode a check reads PayPal's real sandbox history. The agent's name in the audit is
 * CHECKRAIL_AGENT_NAME (default "local-agent"). Whoever can start this process can already open the database, so the
 * local transport needs no key; the hosted one (/api/mcp) does.
 */

// stdout belongs to the protocol. Anything an imported module logs goes to stderr instead.
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;

import readline from "node:readline";

async function main() {
  const { getDb } = await import("../src/lib/db");
  const { handleMcp } = await import("../src/lib/agent/mcp");
  const pkg = await import("../package.json");
  const name = (process.env.CHECKRAIL_AGENT_NAME ?? "local-agent").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "local-agent";
  const requests = process.argv.includes("--allow-requests");
  const supplier = process.argv.find((a) => a.startsWith("--supplier="))?.slice("--supplier=".length) ?? "";
  if (supplier && !/^[A-Za-z0-9_-]{3,64}$/.test(supplier)) throw new Error("--supplier takes a supplier id such as ven_phuong");
  const scopes: Array<"check" | "request" | "attest" | "supplier"> = supplier ? ["check", "request", "supplier"] : requests ? (process.argv.includes("--attest") ? ["check", "request", "attest"] : ["check", "request"]) : ["check"];
  const agent = { name, scopes, digest: Buffer.alloc(32), ...(supplier ? { vendorId: supplier } : {}) };
  const db = getDb();
  const version = (pkg as { version?: string; default?: { version?: string } }).version ?? pkg.default?.version ?? "0.0.0";
  console.error(`[checkrail] MCP on stdio as agent "${name}" (${scopes.join(", ")})`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // One message at a time, in order: a request_payment and the payment_status after it must not race.
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue.then(async () => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      const reply = await handleMcp(msg, { db, agent, version });
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    });
  });
  rl.on("close", () => void queue.then(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
