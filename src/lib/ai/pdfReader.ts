import { readFileSync } from "node:fs";

/**
 * The PDF text reader's process and its limits. pdf.js runs in a child (scripts/pdf-text.mjs) because a crafted PDF
 * can stall it or make it allocate without bound. The limits, outermost first:
 *
 *   - One reader at a time per server, a short queue behind it, and a plain "busy" answer past that. Each reader is a
 *     whole Node process; several at once on a 512 MB instance is how one upload burst takes the server down.
 *   - Inside the child, before pdf.js loads, a scan refuses a file whose streams inflate past a budget
 *     (scripts/pdf-guard.mjs). This stops the plain decompression bomb before it allocates.
 *   - A resident-memory watchdog. pdf.js decodes into buffers outside the V8 heap, so --max-old-space-size alone does
 *     not bound it: a 1.4 MB file grew to about 1 GB in 10 s. The parent reads the child's RSS from /proc every 25 ms
 *     and kills it past the limit; the child also checks itself, which covers systems without /proc.
 *   - The V8 heap flag and a time limit, as before.
 */

/** Longest a PDF may take to read before it is abandoned. */
export const PDF_TIMEOUT_MS = 10_000;
/** The V8 heap the reader may use. pdf.js's own objects fit well inside it; its decoded buffers do not count here. */
export const PDF_HEAP_MB = 128;
/**
 * Resident memory past which the reader is killed. Node with pdf.js loaded sits near 120 MB; the demo invoices peak
 * about 125 MB and a 20-page font-heavy document about 205 to 230 MB, so this leaves room for real invoices while
 * keeping one reader well inside a 512 MB instance with the server beside it.
 */
export const PDF_MAX_RSS_MB = 224;
/** Readers running at once, readers allowed to wait, and how long one waits before it is told to try again. */
export const PDF_MAX_CONCURRENT = 1;
export const PDF_MAX_WAITING = 4;
export const PDF_WAIT_MS = 20_000;

export type PdfTextResult =
  /** text is null when the PDF has no readable text layer, did not parse, or took too long (treated as a scan). */
  | { text: string | null; refused?: undefined }
  /** busy: another reader holds the slot and the queue is full or the wait ran out. limit: the file was too big to read. */
  | { text: null; refused: "busy" | "limit" };

export interface Limiter {
  /** Run `task` when a slot is free. Resolves to null, without running it, when the queue is full or the wait runs out. */
  run<T>(task: () => Promise<T>): Promise<T | null>;
  readonly active: number;
  readonly waiting: number;
}

/** A counting semaphore with a bounded queue and a bounded wait: past either bound the caller is turned away, never stacked up. */
export function createLimiter(opts: { max: number; maxWaiting: number; waitMs: number }): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (active >= opts.max) {
        if (queue.length >= opts.maxWaiting) return null;
        const got = await new Promise<boolean>((resolve) => {
          const grant = () => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            const i = queue.indexOf(grant);
            if (i >= 0) queue.splice(i, 1);
            resolve(false);
          }, opts.waitMs);
          queue.push(grant);
        });
        if (!got) return null;
      }
      active++;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

const slots = createLimiter({ max: PDF_MAX_CONCURRENT, maxWaiting: PDF_MAX_WAITING, waitMs: PDF_WAIT_MS });

/** Resident set size of a process in bytes, from /proc on Linux. null where there is no /proc or the process is gone. */
export function rssOfPid(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export interface PdfReaderOptions {
  /** The child script. Tests pass a stub. */
  script?: string;
  timeoutMs?: number;
  maxRssMb?: number;
  heapMb?: number;
  /** How the parent reads the child's resident memory. Tests pass a stub. */
  rssOf?: (pid: number) => number | null;
  /** The slot limiter. Tests pass their own. */
  limiter?: Limiter;
}

/** Read a PDF's text layer in a child process, one at a time, within the limits above. Never throws. */
export async function readPdfText(bytes: Buffer, opts: PdfReaderOptions = {}): Promise<PdfTextResult> {
  const out = await (opts.limiter ?? slots).run(() => spawnReader(bytes, opts));
  return out ?? { text: null, refused: "busy" };
}

async function spawnReader(bytes: Buffer, opts: PdfReaderOptions): Promise<PdfTextResult> {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const script = opts.script ?? path.join(process.cwd(), "scripts", "pdf-text.mjs");
  const maxRssMb = opts.maxRssMb ?? PDF_MAX_RSS_MB;
  const maxRssBytes = maxRssMb * 1024 * 1024;
  const rssOf = opts.rssOf ?? rssOfPid;
  return new Promise((resolve) => {
    // The child parses a file anyone can upload. It gets a bare environment, not the server's: a pdf.js escape would
    // otherwise find the Anthropic key, the PayPal secret, the Stellar seed and the data key in process.env.
    const child = spawn(process.execPath, [`--max-old-space-size=${opts.heapMb ?? PDF_HEAP_MB}`, script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", PDF_MAX_RSS_MB: String(maxRssMb) },
    });
    let out = "";
    let done = false;
    const finish = (v: PdfTextResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      if (child.exitCode !== null || child.signalCode !== null) return resolve(v);
      // Hold the slot until the killed child is gone and its memory is back, so the next reader never overlaps it.
      child.once("exit", () => resolve(v));
      setTimeout(() => resolve(v), 2_000).unref();
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      console.warn("[documents] pdf text extraction timed out");
      finish({ text: null });
    }, opts.timeoutMs ?? PDF_TIMEOUT_MS);
    const watchdog = setInterval(() => {
      const rss = child.pid ? rssOf(child.pid) : null;
      if (rss !== null && rss > maxRssBytes) {
        console.warn(`[documents] pdf reader stopped at ${Math.round(rss / 1024 / 1024)} MB resident`);
        finish({ text: null, refused: "limit" });
      }
    }, 25);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.length > 1_000_000) finish({ text: null });
    });
    child.on("error", () => finish({ text: null }));
    child.on("close", () => {
      try {
        const j = JSON.parse(out) as { text?: string; error?: string; limit?: boolean };
        if (j.error) console.warn(`[documents] pdf text extraction failed: ${j.error}`);
        finish(j.limit ? { text: null, refused: "limit" } : { text: j.text ?? null });
      } catch {
        finish({ text: null });
      }
    });
    child.stdin.on("error", () => finish({ text: null }));
    child.stdin.end(bytes);
  });
}
