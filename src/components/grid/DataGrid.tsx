"use client";

import { forwardRef, useEffect, useId, useState, type ReactNode } from "react";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";
import {
  CellSpanModule,
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  CustomFilterModule,
  DateFilterModule,
  EventApiModule,
  ExternalFilterModule,
  GridStateModule,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RowApiModule,
  RowSelectionModule,
  RowStyleModule,
  ScrollApiModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  type Module,
} from "ag-grid-community";
import { checkrailGridTheme } from "./theme";
import "./grid.css";

/*
 * Only the community modules these tables use, registered per grid (not globally), so the bundle carries
 * sorting, text, number and date filters, one custom tick-list filter, quick search, external (chip) filters, pinned totals, row selection,
 * cell spanning, grid state (a viewer's sort and filters survive a reload) and CSV export, and nothing else. No enterprise module is imported anywhere.
 */
const MODULES: Module[] = [
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  RowApiModule,
  ScrollApiModule,
  EventApiModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CellStyleModule,
  RowStyleModule,
  CellSpanModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  CustomFilterModule,
  QuickFilterModule,
  ExternalFilterModule,
  PinnedRowModule,
  RowSelectionModule,
  TooltipModule,
  CsvExportModule,
  GridStateModule,
  ...(process.env.NODE_ENV !== "production" ? [ValidationModule] : []),
];

/** Below 640px (Tailwind's sm) a grid is too cramped to read: pages show their card rows instead. */
const PHONE_QUERY = "(max-width: 639.98px)";

/** True on phones. Starts false on the server so the grid HTML hydrates, then follows the viewport. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export type DataGridProps<T> = AgGridReactProps<T> & {
  /** Read by screen readers as the grid's name. */
  label: string;
  /** Optional longer description, announced after the label. */
  description?: string;
  /** Height of the grid in px. Ignored with domLayout="autoHeight". */
  height?: number;
};

/**
 * Checkrail's AG Grid: the app's theme and fonts, the community modules above, an accessible name, and
 * keyboard defaults (arrow keys move between cells, Enter opens the link in the focused cell, Space toggles
 * selection where rows are selectable). The caller owns columns and rows; see LedgerGrid and RunBuilder.
 */
function DataGridInner<T>({ label, description, height, className = "", containerStyle, ...props }: DataGridProps<T>, ref: React.ForwardedRef<AgGridReact<T>>) {
  const labelId = useId();
  const descId = useId();
  return (
    <div className={`cr-grid ${className}`} role="region" aria-labelledby={labelId} aria-describedby={description ? descId : undefined}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      {description ? (
        <span id={descId} className="sr-only">
          {description}
        </span>
      ) : null}
      <AgGridReact<T>
        ref={ref}
        modules={MODULES}
        theme={checkrailGridTheme}
        containerStyle={props.domLayout === "autoHeight" ? containerStyle : { height: height ?? 420, ...containerStyle }}
        suppressMovableColumns
        suppressDragLeaveHidesColumns
        enableCellTextSelection
        ensureDomOrder
        tooltipShowDelay={400}
        accentedSort
        onCellKeyDown={(e) => {
          // Enter on a focused cell follows the first link inside it, so the keyboard reaches the request page.
          const ke = e.event as KeyboardEvent | undefined;
          if (ke?.key !== "Enter" || ke.defaultPrevented) return;
          const cell = (ke.target as HTMLElement | null)?.closest(".ag-cell");
          const link = cell?.querySelector<HTMLAnchorElement>("a[href]");
          if (link) {
            ke.preventDefault();
            link.click();
          }
        }}
        {...props}
      />
    </div>
  );
}

export const DataGrid = forwardRef(DataGridInner) as <T>(p: DataGridProps<T> & { ref?: React.Ref<AgGridReact<T>> }) => ReactNode;

/** Per-viewer grid state (sort, filters, column sizes) in this browser only. Never required: storage can be blocked. */
export function readGridState<S>(key: string): S | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as S) : undefined;
  } catch {
    return undefined;
  }
}

export function writeGridState(key: string, state: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Private window or blocked storage: the grid simply starts fresh next time.
  }
}

/** Search box wired to the grid's quick filter. */
export function GridSearch({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string }) {
  const id = useId();
  return (
    <div className="w-full min-w-0 sm:w-64">
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <input id={id} type="search" className="field" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
    </div>
  );
}

/** A row of toggle chips (for example rails) that drive an external filter. */
export function FilterChips<K extends string>({ label, options, value, onChange }: { label: string; options: Array<{ key: K; label: ReactNode; count?: number }>; value: K | "all"; onChange: (k: K | "all") => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="lbl mb-0 mr-1">{label}</span>
      <button type="button" className={`btn btn-sm ${value === "all" ? "btn-primary" : ""}`} aria-pressed={value === "all"} onClick={() => onChange("all")}>
        All
      </button>
      {options.map((o) => (
        <button key={o.key} type="button" className={`btn btn-sm ${value === o.key ? "btn-primary" : ""}`} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
          {o.count !== undefined ? <span className="num opacity-70">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
