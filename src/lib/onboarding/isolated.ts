import { spawn } from "node:child_process";
import path from "node:path";
import type { RecheckInput, RecheckRow } from "../check/recheck";

const RESULT_MARKER = "@@CHECKRAIL_RECHECK_RESULT@@";
/** 1,000 payments take about 40 seconds; leave room, then give up. */
export const RECHECK_TIMEOUT_MS = 150_000;

/**
 * Run the historical re-check in a child Node process (scripts/recheck-worker.ts). The re-check swaps the global clock
 * per payment, which must never happen inside the server, and it must read with the rules only. The child gets only
 * PATH, NODE_ENV and TZ from this process plus AI_MODE=mock and RAIL_MODE=mock: no keys, no database path, no rail.
 */
export function runRecheckIsolated(input: Omit<RecheckInput, "db">, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RecheckRow[]> {
  const cwd = opts.cwd ?? process.cwd();
  const worker = path.join(cwd, "scripts", "recheck-worker.ts");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
    TZ: process.env.TZ,
    AI_MODE: "mock",
    RAIL_MODE: "mock",
    STELLAR_RAIL: "mock",
    DATABASE_PATH: ":memory:",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the re-check took too long; upload a shorter period"));
    }, opts.timeoutMs ?? RECHECK_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const at = out.lastIndexOf(RESULT_MARKER);
      if (code !== 0 || at < 0) {
        const last = err.trim().split("\n").filter(Boolean).pop() ?? `exit code ${code}`;
        reject(new Error(last.slice(0, 300)));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(at + RESULT_MARKER.length)) as RecheckRow[]);
      } catch {
        reject(new Error("the re-check returned an unreadable result"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
