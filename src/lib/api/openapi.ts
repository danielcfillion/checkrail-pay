import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml";

/** The hand-written spec, docs/openapi.yaml, read once per process and served as JSON at /api/v1/openapi.json. */
let cached: { at: number; spec: unknown } | null = null;

export const OPENAPI_PATH = path.join(process.cwd(), "docs", "openapi.yaml");

export function openApiSpec(file = OPENAPI_PATH): unknown {
  const stat = fs.statSync(file);
  if (cached && cached.at === stat.mtimeMs && file === OPENAPI_PATH) return cached.spec;
  const spec = parseYaml(fs.readFileSync(file, "utf8"));
  if (file === OPENAPI_PATH) cached = { at: stat.mtimeMs, spec };
  return spec;
}
