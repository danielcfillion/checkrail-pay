/**
 * A small reader for the YAML that docs/openapi.yaml is written in, so the hand-written spec can be served as JSON
 * without a runtime dependency. It reads block mappings and sequences (including "- key: value" items), plain, single-
 * and double-quoted scalars, numbers, booleans, null, flow sequences of scalars ([a, b]), the empty map {} and block
 * scalars (|, |-, >, >-). Comments are whole lines only. Anything else is an error, not a guess; the test compares the
 * result with a full YAML parser.
 */

type Line = { indent: number; text: string; raw: string; blank: boolean; no: number };

export class YamlError extends Error {}

export function parseYaml(source: string): unknown {
  const lines: Line[] = source.replace(/^﻿/, "").split(/\r?\n/).map((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)![0])) throw new YamlError(`Line ${i + 1}: tabs are not allowed for indentation`);
    const text = raw.trim();
    return { indent: raw.length - raw.trimStart().length, text, raw, blank: text === "" || text.startsWith("#"), no: i + 1 };
  });
  let i = 0;
  const skip = () => {
    while (i < lines.length && lines[i].blank) i++;
  };
  const isItem = (l: Line) => l.text === "-" || l.text.startsWith("- ");

  function block(indent: number): unknown {
    skip();
    if (i >= lines.length) return null;
    return isItem(lines[i]) ? sequence(indent) : mapping(indent);
  }

  function blockScalar(style: string, parentIndent: number): string {
    const body: Line[] = [];
    while (i < lines.length && (lines[i].text === "" || lines[i].indent > parentIndent)) body.push(lines[i++]);
    while (body.length && body[body.length - 1].text === "") body.pop();
    const content = body.find((l) => l.text !== "");
    if (!content) return "";
    const at = content.indent;
    const rows = body.map((l) => (l.text === "" ? "" : l.raw.slice(at)));
    let out: string;
    if (style.startsWith("|")) out = rows.join("\n");
    else {
      out = "";
      rows.forEach((r, n) => {
        if (n === 0) out = r;
        else if (r === "") out += "\n";
        else out += out.endsWith("\n") ? r : ` ${r}`;
      });
    }
    return style.endsWith("-") ? out : `${out}\n`;
  }

  function value(rest: string, indent: number, line: Line): unknown {
    if (rest === "") {
      i++;
      skip();
      if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i])))) return block(lines[i].indent);
      return null;
    }
    if (["|", "|-", ">", ">-"].includes(rest)) {
      i++;
      return blockScalar(rest, indent);
    }
    i++;
    return scalar(rest, line);
  }

  function mapping(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const line = lines[i];
      if (line.indent < indent) return out;
      if (line.indent > indent) throw new YamlError(`Line ${line.no}: unexpected indentation`);
      if (isItem(line)) return out;
      const { key, rest } = splitKey(line);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`Line ${line.no}: duplicate key ${key}`);
      out[key] = value(rest, indent, line);
    }
  }

  function sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      skip();
      if (i >= lines.length) return out;
      const line = lines[i];
      if (line.indent < indent || !isItem(line) || line.indent > indent) {
        if (line.indent > indent) throw new YamlError(`Line ${line.no}: unexpected indentation`);
        return out;
      }
      const rest = line.text.slice(1).trim();
      if (rest === "") out.push(value("", indent, line));
      else if (/^(?:"[^"]*"|'[^']*'|[^\s"'[{#|>][^:]*?):(?:\s|$)/.test(rest)) {
        // "- key: value": a mapping whose first key sits where the text after the dash starts.
        const at = line.raw.indexOf(rest, line.indent + 1);
        lines[i] = { ...line, indent: at, text: rest };
        out.push(mapping(at));
      } else {
        i++;
        out.push(scalar(rest, line));
      }
    }
  }

  const result = block(0);
  skip();
  if (i < lines.length) throw new YamlError(`Line ${lines[i].no}: unexpected content`);
  return result;
}

function splitKey(line: Line): { key: string; rest: string } {
  const t = line.text;
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = t.indexOf(t[0], 1);
    if (end < 0 || t[end + 1] !== ":") throw new YamlError(`Line ${line.no}: a quoted key must be followed by ":"`);
    return { key: String(scalar(t.slice(0, end + 1), line)), rest: t.slice(end + 2).trim() };
  }
  // A plain key may hold a colon not followed by a space ("departures:write: ...").
  const m = t.match(/^([^:]*?):(?:\s+(.*))?$/) ?? t.match(/^(.*?):\s+(.*)$/) ?? t.match(/^(.*):()$/);
  if (!m) throw new YamlError(`Line ${line.no}: expected "key: value"`);
  return { key: m[1].trim(), rest: (m[2] ?? "").trim() };
}

function splitFlow(s: string, line: Line): string[] {
  const parts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ",") {
      parts.push(cur.trim());
      cur = "";
    } else if (c === "[" || c === "{") throw new YamlError(`Line ${line.no}: nested flow collections are not supported`);
    else cur += c;
  }
  if (q) throw new YamlError(`Line ${line.no}: unclosed quote`);
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function scalar(s: string, line: Line): unknown {
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(`Line ${line.no}: unclosed double quote`);
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`Line ${line.no}: a double-quoted string uses only JSON escapes here`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`Line ${line.no}: unclosed single quote`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new YamlError(`Line ${line.no}: unclosed flow sequence`);
    return splitFlow(s.slice(1, -1), line).map((p) => scalar(p, line));
  }
  if (s === "{}") return {};
  if (s.startsWith("{") || s.startsWith("&") || s.startsWith("*") || s.startsWith("!")) throw new YamlError(`Line ${line.no}: flow maps, anchors, aliases and tags are not supported`);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s);
  if (/\s#/.test(s) || /:\s/.test(s)) throw new YamlError(`Line ${line.no}: quote a value that contains ": " or " #"`);
  return s;
}
