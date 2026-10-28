// Reads a PDF's text layer in its own process, so a hostile PDF (a decompression bomb, a pathological
// content stream) can stall or exhaust only this child, never the server. Bytes arrive on stdin; JSON on stdout.
// Run by src/lib/ai/documents.ts with a time limit and a heap limit.
const MAX_PAGES = 20;
const MAX_TEXT = 200_000;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const data = new Uint8Array(Buffer.concat(chunks));
try {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, maxImageSize: 1 }).promise;
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
  process.stdout.write(JSON.stringify({ text: parts.join("\n").slice(0, MAX_TEXT) }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message ? e.message : e).slice(0, 300) }));
}
