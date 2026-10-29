import { forbiddenCopy, type CopyFinding } from "../src/lib/copy-check";

/** The main routes, plus every request, vendor and run page linked from them (up to a limit each). */
export const MAIN_ROUTES = ["/", "/demo", "/obligations", "/obligations?filter=needs_action", "/obligations?filter=blocked", "/obligations/new", "/exceptions", "/runs", "/bank-files", "/vendors", "/vendors/new", "/departures", "/ledger", "/accounting", "/books", "/close", "/audit", "/settings", "/obligations/obl_doesnotexist"];

export async function crawlCopy(base: string, auth: string, opts: { perKind?: number } = {}): Promise<Array<CopyFinding & { path: string }>> {
  const headers = { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` };
  const seen = new Set<string>();
  const queue = [...MAIN_ROUTES];
  const kinds: Record<string, number> = {};
  const per = opts.perKind ?? 12;
  const out: Array<CopyFinding & { path: string }> = [];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetch(new URL(path, base), { headers, redirect: "follow" });
    const html = await res.text();
    if (res.status >= 500) out.push({ path, word: `HTTP ${res.status}`, context: html.slice(0, 120), severity: "error" });
    for (const f of forbiddenCopy(html)) out.push({ ...f, path });
    for (const m of html.matchAll(/href="(\/(?:obligations\/obl_[a-z0-9]+|vendors\/ven_[a-z0-9]+|runs\/run_[a-z0-9]+))"/g)) {
      const kind = m[1].split("/")[1];
      if (seen.has(m[1]) || queue.includes(m[1]) || (kinds[kind] ?? 0) >= per) continue;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      queue.push(m[1]);
    }
  }
  return out;
}
