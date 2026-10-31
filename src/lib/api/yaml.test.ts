import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parseYaml, YamlError } from "./yaml";
import { OPENAPI_PATH, openApiSpec } from "./openapi";

describe("the YAML reader", () => {
  it("reads maps, lists, list items that are maps, scalars, flow lists and block scalars", () => {
    const src = [
      "# a comment",
      "a: 1",
      "b: text with spaces",
      'c: "quoted: yes"',
      "d: 'it''s'",
      "e: [x, 'y', \"z\", null]",
      "f: {}",
      "g:",
      "  - one",
      "  - k: v",
      "    k2: [1, 2]",
      "  -",
      "    nested: true",
      "h: >-",
      "  folded",
      "  line",
      "",
      "  next",
      "i: |",
      "  literal",
      "  kept",
      "departures:write: scope",
      "j:",
      "- same-indent item",
      '"200":',
      "  ok: ~",
    ].join("\n");
    expect(parseYaml(src)).toEqual({
      a: 1,
      b: "text with spaces",
      c: "quoted: yes",
      d: "it's",
      e: ["x", "y", "z", null],
      f: {},
      g: ["one", { k: "v", k2: [1, 2] }, { nested: true }],
      h: "folded line\nnext",
      i: "literal\nkept\n",
      "departures:write": "scope",
      j: ["same-indent item"],
      "200": { ok: null },
    });
  });

  it("refuses what it does not read rather than guessing", () => {
    for (const bad of ["a: b: c", "a: x #comment", "a: &anchor 1", "a: [[1]]", "a:\n\tb: 1", "a: 1\na: 2", "a: 1\n   b: 2"]) expect(() => parseYaml(bad), bad).toThrow(YamlError);
  });
});

describe("docs/openapi.yaml", () => {
  it("is read the same as a full YAML parser reads it", async () => {
    const name = "js-yaml";
    const full = (await import(/* @vite-ignore */ name).catch(() => null)) as { load(s: string): unknown } | null;
    if (!full) return; // js-yaml is a dev-only transitive dependency; without it the structural test below still runs
    const src = fs.readFileSync(OPENAPI_PATH, "utf8");
    expect(parseYaml(src)).toEqual((full.load ?? (full as unknown as { default: { load(s: string): unknown } }).default.load)(src));
  });

  it("describes every endpoint and every reference resolves", () => {
    const spec = openApiSpec() as { openapi: string; paths: Record<string, Record<string, unknown>>; components: Record<string, Record<string, unknown>> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.fromEntries(Object.entries(spec.paths).map(([p, ops]) => [p, Object.keys(ops).sort()]))).toEqual({
      "/departures": ["get", "post"],
      "/requests": ["get", "post"],
      "/requests/{id}": ["get"],
      "/vendors": ["get"],
      "/openapi.json": ["get"],
    });
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/([A-Za-z]+)\/([A-Za-z]+)"/g)];
    expect(refs.length).toBeGreaterThan(20);
    for (const [, group, item] of refs) expect(spec.components[group]?.[item], `${group}/${item}`).toBeTruthy();
    expect(JSON.stringify(spec)).not.toMatch(/\u2014/);
  });
});
