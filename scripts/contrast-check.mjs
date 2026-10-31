#!/usr/bin/env node
/*
 * Contrast check for the colour tokens in src/app/globals.css (WCAG 2 relative luminance).
 *   node scripts/contrast-check.mjs
 * Text pairs must reach 4.5:1; swatches and non-text marks 3:1. Soft tints are composited over the sheet colour,
 * which is where tags and pills sit. Exits 1 if any pair fails.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");

function block(re) {
  const m = css.match(re);
  if (!m) throw new Error(`token block not found: ${re}`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}
const light = block(/^:root \{([\s\S]*?)\n\}/m);
const dark = { ...light, ...block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/) };

function parse(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`cannot parse colour ${v}`);
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => {
  const [r, g, b] = c.slice(0, 3).map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const hex = (c) => "#" + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");

// [label, foreground token, background token or null for the sheet, minimum]
const PAIRS = [
  ["Ink soft on sheet", "ink-soft", "sheet", 4.5],
  ["Action button", "action-ink", "action", 4.5],
  ["Action text on sheet", "action", "sheet", 4.5],
  ["Hero number", "hero-ink", "hero", 4.5],
  ["Block banner text", "alarm-ink", "alarm", 4.5],
  ["Block banner detail", "alarm-soft", "alarm", 4.5],
  ["Hero caption", "hero-soft", "hero", 4.5],
  ["Ink soft on paper", "ink-soft", "paper", 4.5],
  ["PayPal tag", "paypal-text", "paypal-soft", 4.5],
  ["Stellar tag", "stellar-text", "stellar-soft", 4.5],
  ["Wise tag", "wise", "wise-soft", 4.5],
  ["Bank tag", "ink", "rail-bank-soft", 4.5],
  ["Settled text on sheet", "settled", "sheet", 4.5],
  ["Settled pill", "settled", "settled-soft", 4.5],
  ["Settled text on paper", "settled", "paper", 4.5],
  ["Attention text on sheet", "attention", "sheet", 4.5],
  ["Attention pill", "attention", "attention-soft", 4.5],
  ["Blocked text on sheet", "blocked", "sheet", 4.5],
  ["Blocked pill", "blocked", "blocked-soft", 4.5],
  ["Neutral pill", "ink", "neutral-soft", 4.5],
  ["Muted pill", "ink-soft", "neutral-soft", 4.5],
  ["Primary button", "primary-ink", "primary", 4.5],
  ["Settled button", "settled-ink", "settled", 4.5],
  ["Ink soft on settled tint", "ink-soft", "settled-soft", 4.5],
  ["Ink soft on attention tint", "ink-soft", "attention-soft", 4.5],
  ["Bank swatch on sheet (graphic)", "rail-bank", "sheet", 3],
  ["Bank swatch on sheet (as text)", "rail-bank", "sheet", 4.5],
  ["Focus ring on sheet (graphic)", "focus", "sheet", 3],
  // The edge of a text field is the only thing that shows where to type (WCAG 1.4.11): 3:1 on the sheet and on paper.
  ["Field border on sheet (graphic)", "field-border", "sheet", 3],
  ["Field border on paper (graphic)", "field-border", "paper", 3],
];

let failed = 0;
for (const [name, theme] of [["light", light], ["dark", dark]]) {
  const sheet = parse(theme.sheet);
  console.log(`\n${name}`);
  for (const [label, fgKey, bgKey, min] of PAIRS) {
    const bgRaw = parse(theme[bgKey]);
    const bg = bgKey === "sheet" || bgKey === "paper" ? bgRaw : over(bgRaw, sheet);
    const fg = over(parse(theme[fgKey]), bg);
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? "pass" : "FAIL"}  ${r.toFixed(2).padStart(5)}  ${label.padEnd(32)} ${hex(fg)} on ${hex(bg)}`);
  }
}

// Soft tints must read as different colours in dark (DS-11): report the distance between settled and attention.
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
for (const [name, theme] of [["light", light], ["dark", dark]]) {
  const s = parse(theme.sheet);
  const a = over(parse(theme["settled-soft"]), s);
  const b = over(parse(theme["attention-soft"]), s);
  console.log(`\n${name}: settled-soft ${hex(a)} vs attention-soft ${hex(b)}, RGB distance ${d(a, b).toFixed(1)}`);
}
process.exit(failed ? 1 : 0);
