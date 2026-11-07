// Reads a PDF's text layer in its own process, so a hostile PDF (a decompression bomb, a pathological
// content stream) can stall or exhaust only this child, never the server. Bytes arrive on stdin; JSON on stdout.
// Run by src/lib/ai/pdfReader.ts with a time limit, a heap limit and a resident-memory watchdog.
// `{ "limit": true }` in the output means the file was refused for size, not that it failed to parse.
import { checkInflatedSize } from "./pdf-guard.mjs";

const MAX_PAGES = 20;
const MAX_TEXT = 200_000;

/** One JSON answer only, whichever of the reader and the watchdog below gets there first. */
let sent = false;
function send(obj, then) {
  if (sent) return;
  sent = true;
  process.stdout.write(JSON.stringify(obj), then);
}

// Second line of defence after the parent's watchdog (which reads /proc and works only on Linux): stop when this
// process's resident memory passes the limit the parent passed in. Runs only while the event loop is free.
const maxRssBytes = Number(process.env.PDF_MAX_RSS_MB) * 1024 * 1024;
if (maxRssBytes > 0) {
  setInterval(() => {
    if (process.memoryUsage.rss() > maxRssBytes) {
      send({ error: "memory limit", limit: true }, () => process.exit(3));
    }
  }, 25).unref();
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const data = new Uint8Array(Buffer.concat(chunks));
try {
  // Before pdf.js sees the file: refuse one whose streams inflate past the budget.
  const guard = await checkInflatedSize(data);
  if (!guard.ok) {
    send({ error: `refused: ${guard.reason}`, limit: true });
  } else {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, maxImageSize: 1, isOffscreenCanvasSupported: false, verbosity: 0 }).promise;
    const parts = [];
    let size = 0;
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      parts.push(text);
      size += text.length;
      if (size > MAX_TEXT) break;
    }
    send({ text: parts.join("\n").slice(0, MAX_TEXT) });
  }
} catch (e) {
  send({ error: String(e && e.message ? e.message : e).slice(0, 300) });
}
