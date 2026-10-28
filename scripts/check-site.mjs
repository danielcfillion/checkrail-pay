#!/usr/bin/env node
// Fails if the landing page (site/*.html) could show a dead link.
//
//     node scripts/check-site.mjs
//
// A link with href="#" (or an empty href) is allowed only as a placeholder the page hides: the <a> itself, or a wrapper
// around it, carries data-placeholder-link, and the page keeps the script that hides those. Anything else fails.
// Also fails if the social card image is not an absolute https URL, because link previews ignore relative paths.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const problems = [];

for (const file of readdirSync(site).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(site, file), "utf8").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const hidesPlaceholders = /querySelectorAll\(\s*["']\[data-placeholder-link\]["']\s*\)/.test(html) && /\.hidden\s*=\s*true/.test(html);

  // Walk the tags with a stack, so a placeholder wrapper covers the links inside it.
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g;
  const voidTags = new Set(["meta", "link", "img", "br", "hr", "input", "source", "path", "line", "circle", "rect"]);
  let m;
  while ((m = tagRe.exec(html))) {
    const [whole, name, attrs] = m;
    const tag = name.toLowerCase();
    if (whole.startsWith("</")) {
      const i = stack.map((t) => t.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const placeholder = /\sdata-placeholder-link\b/.test(attrs);
    if (tag === "a") {
      const href = /\shref\s*=\s*["']([^"']*)["']/.exec(attrs);
      const dead = href && (href[1] === "#" || href[1].trim() === "");
      if (dead) {
        const covered = placeholder || stack.some((t) => t.placeholder);
        const line = html.slice(0, m.index).split("\n").length;
        if (!covered) problems.push(`${file}:${line} visible dead link: ${whole.trim()}`);
        else if (!hidesPlaceholders) problems.push(`${file}:${line} placeholder link, but the script that hides placeholders is missing`);
      }
    }
    if (!voidTags.has(tag) && !whole.endsWith("/>")) stack.push({ tag, placeholder });
  }

  const og = /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/.exec(html);
  if (og && !/^https:\/\//.test(og[1])) problems.push(`${file}: og:image must be an absolute https URL, found "${og[1]}"`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("site: no visible dead links");
