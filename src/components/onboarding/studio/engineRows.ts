"use client";

import { useEffect, useState } from "react";
import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import type { studioRows } from "@/lib/studio/onboardingData";

/** What the page hands every widget through Studio's `context` property: the same rows Studio's data engine holds. */
export interface WidgetContext {
  rows: ReturnType<typeof studioRows>;
}

type Table = keyof WidgetContext["rows"];

const pad = (n: number) => String(n).padStart(2, "0");

/** The engine hands date fields back as Dates at local midnight: always YYYY-MM-DD here, in the same local day. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return value;
}

function fieldFor(fields: AgWidgetField[], table: string, name: string): AgWidgetField | undefined {
  return fields.find((f) => f.fieldId === `${table}.${name}`) ?? fields.find((f) => f.fieldId === name);
}

/**
 * Rows of one table for a custom widget, read through Studio's data engine (so page filters apply), as plain
 * objects keyed by the backend's field names. Each table is its own query (`queryId`), so a widget reading two
 * tables does not have one answer superseded by the other. If the engine cannot answer (a field missing from the
 * schema, a query that fails), the widget falls back to the same rows from the page's context rather than
 * showing nothing.
 */
export function useEngineRows<T extends object>(params: AgWidgetParams, table: Table, names: (keyof T & string)[]): { rows: T[] | null; source: "engine" | "context" | null } {
  const [state, setState] = useState<{ rows: T[] | null; source: "engine" | "context" | null }>({ rows: null, source: null });
  const key = names.join(",");

  useEffect(() => {
    let live = true;
    const fallback = () => {
      const rows = ((params.context as WidgetContext | undefined)?.rows?.[table] ?? []) as unknown as T[];
      if (live) setState({ rows, source: "context" });
    };
    (async () => {
      try {
        const schema = params.widgetApi.getSchema();
        const fields = schema.find((t) => t.id === table)?.fields ?? schema.flatMap((t) => t.fields);
        const picked = key.split(",").map((n) => fieldFor(fields, table, n));
        if (picked.some((f) => !f)) return fallback();
        const res = await params.widgetApi.getData({ fields: picked as AgWidgetField[] }, { queryId: `checkrail-${table}` });
        const rows = res.results.rows.map((row) => Object.fromEntries(key.split(",").map((n, i) => [n, plain(row[(picked[i] as AgWidgetField).key])])) as T);
        if (live) setState({ rows, source: "engine" });
      } catch {
        fallback();
      }
    })();
    return () => {
      live = false;
    };
  }, [params, table, key]);

  return state;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}
