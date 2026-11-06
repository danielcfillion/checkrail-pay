// Decompression-bomb guard for scripts/pdf-text.mjs. pdf.js inflates Flate streams into buffers outside the V8 heap,
// so --max-old-space-size does not bound them: a 1.4 MB file can inflate to over a gigabyte. Before pdf.js is loaded,
// every stream that zlib can inflate is inflated here, counting bytes and keeping none, and the file is refused once
// the total passes a budget. Memory stays flat: output chunks are counted and dropped.
//
// Each stream is fed from its start to the end of the file, not to its `endstream`: zlib stops at the end of the
// deflate data, so neither a wrong /Length nor an "endstream" planted inside the compressed bytes can hide output.
// Image streams are skipped: text extraction never decodes them, and a scanned invoice's pages can be large.
// Anything this misses (another filter, an encrypted stream) is still bounded by the parent's memory watchdog.
import { createInflate, constants } from "node:zlib";

/**
 * Inflated bytes allowed across all of a file's non-image streams. An invoice's text, fonts and xref use a few MB;
 * the heaviest real documents measured (20-page font specimens, an emoji catalogue) inflate to 3 to 14 MB.
 */
export const INFLATE_BUDGET_BYTES = 32 * 1024 * 1024;
/** More streams than any invoice has; past this the file is refused rather than scanned for minutes. */
export const MAX_STREAMS = 5000;

const STREAM_KEYWORD = /(?<![A-Za-z])stream(?:\r\n|\n|\r)/g;

/**
 * Whether the file's streams inflate within the budget. Returns { ok: true, inflated } or { ok: false, reason }.
 * @param {Uint8Array} data
 * @param {{ budgetBytes?: number, maxStreams?: number }} [opts]
 */
export async function checkInflatedSize(data, opts = {}) {
  const budget = opts.budgetBytes ?? INFLATE_BUDGET_BYTES;
  const maxStreams = opts.maxStreams ?? MAX_STREAMS;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const text = buf.toString("latin1");
  let total = 0;
  let streams = 0;
  let lastObjEnd = 0;
  for (const m of text.matchAll(STREAM_KEYWORD)) {
    if (++streams > maxStreams) return { ok: false, reason: `more than ${maxStreams} streams` };
    const start = m.index + m[0].length;
    // The stream's dictionary is the text since the object header ("12 0 obj") that precedes it.
    const before = text.slice(Math.max(lastObjEnd, m.index - 4096), m.index);
    const header = before.lastIndexOf(" obj");
    const dict = header >= 0 ? before.slice(header) : before;
    lastObjEnd = start;
    if (/\/Subtype\s*\/Image\b/.test(dict)) continue;
    total += await inflatedBytes(buf.subarray(start), budget - total);
    if (total > budget) return { ok: false, reason: `streams inflate past ${Math.round(budget / 1024 / 1024)} MB` };
  }
  return { ok: true, inflated: total };
}

/** Bytes zlib produces from the start of `input`, stopping once past `limit`. 0 when it is not zlib data. */
function inflatedBytes(input, limit) {
  return new Promise((resolve) => {
    let n = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      inf.destroy();
      resolve(n);
    };
    // Sync flush: a truncated stream still counts what it produced instead of failing before anything is counted.
    const inf = createInflate({ finishFlush: constants.Z_SYNC_FLUSH });
    inf.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) done();
    });
    inf.on("end", done);
    inf.on("error", done);
    inf.end(input);
  });
}
