/**
 * What a person can read on a server-rendered page, and the words that must never be in it (DS2-5). Code names and
 * URLs keep "obligation" (`/obligations/obl_...`, `obligationId`); people never see it.
 *
 * Reads the HTML as served: text between tags and the attributes people read or hear (title, aria-label,
 * placeholder, alt, a meta description). Scripts (the React flight data), styles and every other attribute are
 * skipped, so an href or a JSON key does not count. So is `<pre>`: the app uses it only for raw stored records (an
 * audit entry's detail JSON, the policy JSON) shown verbatim behind a "Detail" disclosure.
 *
 * "obligation" fails the check. Internal ids are reported as warnings: a labelled "Request id" with a copy button is
 * meant to show one.
 */

const SPOKEN_ATTRS = ["title", "aria-label", "aria-description", "placeholder", "alt"];

export type CopyFinding = { word: string; context: string; severity: "error" | "warning" };

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/** Visible text and spoken attributes, one fragment per entry. */
export function readableFragments(html: string): string[] {
  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const out: string[] = [];
  const tag = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|<\/[a-zA-Z][\w-]*\s*>/g;
  let last = 0;
  for (const m of body.matchAll(tag)) {
    const text = body.slice(last, m.index).trim();
    if (text) out.push(decode(text));
    last = (m.index ?? 0) + m[0].length;
    const attrs = m[2] ?? "";
    const isMetaDescription = m[1]?.toLowerCase() === "meta" && /name\s*=\s*["'](description|og:description|twitter:description)["']|property\s*=\s*["']og:(title|description)["']/i.test(attrs);
    for (const a of attrs.matchAll(/([^\s=>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (SPOKEN_ATTRS.includes(name) || (isMetaDescription && name === "content")) if (value.trim()) out.push(decode(value));
    }
  }
  const tail = body.slice(last).trim();
  if (tail) out.push(decode(tail));
  return out;
}

/** "obligation" in any form, and internal ids (obl_..., ven_...). */
const FORBIDDEN: Array<[string, RegExp, CopyFinding["severity"]]> = [
  ["obligation", /\bobligations?\b/i, "error"],
  ["internal id", /\b(?:obl|ven|evd|att|rte|dep)_[a-z0-9]{6,}\b/i, "warning"],
];

export function forbiddenCopy(html: string): CopyFinding[] {
  const found: CopyFinding[] = [];
  for (const f of readableFragments(html)) {
    for (const [word, re, severity] of FORBIDDEN) {
      const m = f.match(re);
      if (m) {
        const i = m.index ?? 0;
        found.push({ word, severity, context: f.slice(Math.max(0, i - 50), i + 60).replace(/\s+/g, " ") });
      }
    }
  }
  return found;
}
