import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeflate } from "node:zlib";
import { createLimiter, readPdfText, rssOfPid } from "./pdfReader";
import { PDF_BUSY_NOTE, PDF_LIMIT_NOTE, readDocument } from "./documents";
import { checkInflatedSize } from "../../../scripts/pdf-guard.mjs";

/**
 * RT-5: the PDF reader's memory and concurrency limits. A 1.4 MB PDF whose one content stream inflates to 1.4 GB
 * took the reader to about 1 GB resident, outside the V8 heap flag, and nothing limited how many ran at once.
 */

const root = path.join(__dirname, "..", "..", "..");
const demoDir = path.join(root, "docs", "demo-documents");
const demoPdfs = readdirSync(demoDir).filter((f) => f.endsWith(".pdf"));

/** Deflate `bytes` of spaces without holding them: a small file that inflates to a large stream. */
async function deflatedSpaces(bytes: number): Promise<Buffer> {
  const d = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  d.on("data", (c: Buffer) => parts.push(c));
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  for (let left = bytes; left > 0; left -= chunk.length) {
    if (!d.write(left >= chunk.length ? chunk : chunk.subarray(0, left))) await new Promise((r) => d.once("drain", r));
  }
  d.end();
  await new Promise((r) => d.on("end", r));
  return Buffer.concat(parts);
}

/** A one-page PDF whose content stream is `stream`, deflated. `dictExtra` goes into the stream's dictionary. */
function onePagePdf(stream: Buffer, dictExtra = ""): Buffer {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"];
  let body = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)]);
  });
  offsets.push(body.length);
  body = Buffer.concat([body, Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode${dictExtra} >>\nstream\n`), stream, Buffer.from("\nendstream\nendobj\n")]);
  const xref = body.length;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.concat([body, Buffer.from(`xref\n0 5\n0000000000 65535 f \n${rows}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}

let stubs: string;
beforeAll(() => {
  stubs = mkdtempSync(path.join(tmpdir(), "pdf-reader-test-"));
  // Never answers: only the parent's timeout or watchdog ends it.
  writeFileSync(path.join(stubs, "hang.mjs"), "setInterval(() => {}, 1000);\n");
  // Grows resident memory in a synchronous loop (so its own event loop is blocked and only the parent can stop it),
  // never past 400 MB, then spins. Stands in for pdf.js inflating a bomb.
  writeFileSync(
    path.join(stubs, "grow.mjs"),
    "const keep = []; for (let i = 0; i < 50; i++) { keep.push(Buffer.alloc(8 * 1024 * 1024, 1)); const t = Date.now(); while (Date.now() - t < 50); }\nfor (;;) {}\n",
  );
});
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

describe("RT-5: one PDF reader at a time, with a short queue", () => {
  it("runs one task, queues up to the limit, and turns the rest away without running them", async () => {
    const lim = createLimiter({ max: 1, maxWaiting: 1, waitMs: 5_000 });
    let release!: () => void;
    const first = lim.run(() => new Promise<string>((r) => (release = () => r("first"))));
    const second = lim.run(async () => "second");
    let ranThird = false;
    const third = await lim.run(async () => ((ranThird = true), "third"));
    expect(third).toBeNull();
    expect(ranThird).toBe(false);
    expect([lim.active, lim.waiting]).toEqual([1, 1]);
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect([lim.active, lim.waiting]).toEqual([0, 0]);
  });

  it("gives up on a wait that runs out, and frees its place in the queue", async () => {
    const lim = createLimiter({ max: 1, maxWaiting: 1, waitMs: 50 });
    let release!: () => void;
    const first = lim.run(() => new Promise<void>((r) => (release = r)));
    expect(await lim.run(async () => "late")).toBeNull();
    expect(lim.waiting).toBe(0);
    release();
    await first;
    expect(await lim.run(async () => "now")).toBe("now");
  });

  it("a slot freed by a failing task is reused", async () => {
    const lim = createLimiter({ max: 1, maxWaiting: 0, waitMs: 50 });
    await expect(lim.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lim.run(async () => "ok")).toBe("ok");
  });

  it("an upload while the server's reader and queue are full is told plainly to try again, and nothing is read", async () => {
    const hang = path.join(stubs, "hang.mjs");
    // Fill the server's own slot and its queue with readers that never answer and time out after 300 ms each.
    const held = Array.from({ length: 5 }, () => readPdfText(Buffer.from("%PDF-1.4"), { script: hang, timeoutMs: 300 }));
    const r = await readDocument({ name: "invoice-rosa-0942.pdf", mimeType: "application/pdf", bytes: readFileSync(path.join(demoDir, "invoice-rosa-0942.pdf")), baseCurrency: "USD" });
    expect(r).toMatchObject({ reader: "none", text: null, proposed: [], note: PDF_BUSY_NOTE });
    expect((await Promise.all(held)).every((h) => h.text === null && !h.refused)).toBe(true);
  }, 30_000);
});

describe("RT-5: the reader's memory is bounded", () => {
  it("kills a reader whose resident memory passes the limit, and says the file could not be read", async () => {
    const t0 = Date.now();
    const r = await readPdfText(Buffer.from("%PDF-1.4"), { script: path.join(stubs, "hang.mjs"), rssOf: () => 999 * 1024 * 1024, timeoutMs: 20_000 });
    expect(r).toEqual({ text: null, refused: "limit" });
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);

  it.runIf(process.platform === "linux")("measures the child's real resident memory and stops it in a blocking allocation loop", async () => {
    let peak = 0;
    const r = await readPdfText(Buffer.from("%PDF-1.4"), {
      script: path.join(stubs, "grow.mjs"),
      maxRssMb: 96,
      timeoutMs: 20_000,
      rssOf: (pid) => {
        const v = rssOfPid(pid);
        if (v) peak = Math.max(peak, v);
        return v;
      },
    });
    expect(r).toEqual({ text: null, refused: "limit" });
    // Stopped near the limit, not at the stub's 400 MB.
    expect(peak / 1024 / 1024).toBeLessThan(200);
  }, 30_000);

  it("the stream scan refuses a file whose content inflates past the budget, before pdf.js sees it", async () => {
    const bomb = onePagePdf(await deflatedSpaces(4 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(await checkInflatedSize(new Uint8Array(bomb), { budgetBytes: 1024 * 1024 })).toMatchObject({ ok: false });
    expect(await checkInflatedSize(new Uint8Array(bomb), { budgetBytes: 8 * 1024 * 1024 })).toEqual({ ok: true, inflated: 4 * 1024 * 1024 });
    // Image streams are not decoded for text, so they do not count; a truncated stream still counts what it produced.
    expect(await checkInflatedSize(new Uint8Array(onePagePdf(await deflatedSpaces(4 * 1024 * 1024), " /Subtype /Image")), { budgetBytes: 1024 * 1024 })).toEqual({ ok: true, inflated: 0 });
  }, 30_000);

  it("the stream scan is not fooled by a /Length that understates the stream", async () => {
    const z = await deflatedSpaces(4 * 1024 * 1024);
    const lying = Buffer.from(onePagePdf(z).toString("latin1").replace(`/Length ${z.length}`, "/Length 10"), "latin1");
    expect(await checkInflatedSize(new Uint8Array(lying), { budgetBytes: 1024 * 1024 })).toMatchObject({ ok: false });
  }, 30_000);

  it("a decompression bomb upload gets a clean 'could not read this file' and no figures", async () => {
    const bomb = onePagePdf(await deflatedSpaces(200 * 1024 * 1024));
    const r = await readDocument({ name: "invoice.pdf", mimeType: "application/pdf", bytes: bomb, baseCurrency: "USD" });
    expect(r).toMatchObject({ reader: "none", text: null, proposed: [], note: PDF_LIMIT_NOTE });
  }, 60_000);

  it("the demo documents still read, and the copies served to the browser are the same files", async () => {
    expect(demoPdfs.length).toBeGreaterThan(0);
    for (const f of demoPdfs) {
      const bytes = readFileSync(path.join(demoDir, f));
      expect(readFileSync(path.join(root, "public", "demo-documents", f)).equals(bytes)).toBe(true);
      const r = await readDocument({ name: f, mimeType: "application/pdf", bytes, baseCurrency: "USD" });
      expect(r.reader, f).toBe("pdf-text");
      expect(r.note, f).toBeNull();
      expect(r.proposed[0].amountMinor, f).toBeGreaterThan(0);
    }
  }, 120_000);
});
