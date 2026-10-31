/**
 * The owner's own layout of "Your first weeks", kept in this browser only. It is a convenience: any failure to read
 * or write storage (private window, blocked site data, quota) falls back to the default layout from code, and a
 * saved layout from an older version of the default, or one that names a widget type Studio no longer has, is
 * ignored rather than loaded.
 */
import type { AgReportState } from "ag-studio";

export const LAYOUT_KEY = "checkrail:onboarding-dashboard:layout";
/** Bump when the default layout or the data source ids change, so stale saved layouts are dropped. */
export const LAYOUT_VERSION = 1;

interface Saved {
  v: number;
  state: AgReportState;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The durable part of a report: pages, widgets, layout and filters. Selection, panels and cross filters are not kept. */
export function durable(state: AgReportState): AgReportState {
  return {
    selectedPageId: state.selectedPageId,
    pages: state.pages.map(({ id, widgets, widgetLayout, layout, filter }) => ({ id, widgets, widgetLayout, layout, filter })),
  };
}

/** True when two reports differ in anything the owner would call "the layout". */
export const differs = (a: AgReportState, b: AgReportState) => JSON.stringify(durable(a)) !== JSON.stringify(durable(b));

/** Parse a saved layout, or null when it is missing, corrupt, from another version, or names an unknown widget type. */
export function parseSaved(raw: string | null, knownTypes: ReadonlySet<string>): AgReportState | null {
  if (!raw) return null;
  let saved: Saved;
  try {
    saved = JSON.parse(raw) as Saved;
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object" || saved.v !== LAYOUT_VERSION) return null;
  const state = saved.state;
  if (!state || !Array.isArray(state.pages) || !state.pages.length || typeof state.selectedPageId !== "string") return null;
  if (!state.pages.some((p) => p && p.id === state.selectedPageId)) return null;
  for (const p of state.pages) {
    if (!p || typeof p.id !== "string") return null;
    for (const w of Object.values(p.widgets ?? {})) {
      const type = (w as { type?: unknown } | undefined)?.type;
      if (typeof type !== "string" || !knownTypes.has(type)) return null;
    }
  }
  return state;
}

export function loadLayout(knownTypes: ReadonlySet<string>, store: StorageLike | null = storage()): AgReportState | null {
  try {
    return parseSaved(store?.getItem(LAYOUT_KEY) ?? null, knownTypes);
  } catch {
    return null;
  }
}

export function saveLayout(state: AgReportState, store: StorageLike | null = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(LAYOUT_KEY, JSON.stringify({ v: LAYOUT_VERSION, state: durable(state) } satisfies Saved));
    return true;
  } catch {
    return false;
  }
}

export function clearLayout(store: StorageLike | null = storage()): void {
  try {
    store?.removeItem(LAYOUT_KEY);
  } catch {
    // Storage blocked: nothing was saved to clear.
  }
}
