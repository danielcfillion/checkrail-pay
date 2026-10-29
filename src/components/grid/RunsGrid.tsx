"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { CustomCellRendererProps } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { DataGrid, usePhone } from "./DataGrid";
import { CellLink } from "./cells";
import type { RunRow } from "./model";

const STATUS_TONE: Record<string, string> = {
  draft: "bg-attention-soft text-attention",
  releasing: "bg-neutral-soft text-ink",
  released: "bg-settled-soft text-settled",
  cancelled: "bg-neutral-soft text-ink-soft",
};

function RunStatus({ status, label }: { status: string; label: string }) {
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-xs font-medium leading-4 ${STATUS_TONE[status] ?? STATUS_TONE.releasing}`}>{label}</span>;
}

const totalText = (r: RunRow) => r.totals.map((t) => formatMoney(t.minor, t.currency)).join(" + ");

/** Every payment run, newest first. Sorting by total compares runs at reference rates. */
export function RunsGrid({ rows }: { rows: RunRow[] }) {
  const phone = usePhone();
  const columnDefs = useMemo<ColDef<RunRow>[]>(
    () => [
      {
        colId: "name",
        field: "name",
        headerName: "Run",
        minWidth: 180,
        flex: 1.4,
        cellRenderer: (p: CustomCellRendererProps<RunRow>) =>
          p.data ? (
            <CellLink href={`/runs/${p.data.id}`} label={`Open run ${p.data.name}`}>
              {p.data.name}
            </CellLink>
          ) : null,
      },
      {
        colId: "status",
        field: "statusLabel",
        headerName: "Status",
        width: 170,
        filter: "agTextColumnFilter",
        filterParams: { buttons: ["clear"], maxNumConditions: 1 },
        cellRenderer: (p: CustomCellRendererProps<RunRow>) => (p.data ? <RunStatus status={p.data.status} label={p.data.statusLabel} /> : null),
      },
      { colId: "createdBy", field: "createdBy", headerName: "Built by", width: 140, cellClass: "cr-soft" },
      {
        colId: "createdAt",
        field: "createdAt",
        headerName: "Created",
        width: 130,
        sort: "desc",
        cellClass: "cr-soft",
        valueFormatter: (p) => formatDate(p.value),
        tooltipValueGetter: (p) => formatDateTime(p.value),
      },
      { colId: "progress", field: "progress", headerName: "Payments", width: 170, type: "rightAligned", headerClass: "cr-right", cellClass: "cr-right", comparator: (_a, _b, na, nb) => (na.data?.count ?? 0) - (nb.data?.count ?? 0) },
      {
        colId: "total",
        headerName: "Total",
        width: 190,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right",
        valueGetter: (p) => (p.data ? totalText(p.data) : ""),
        comparator: (_a, _b, na, nb) => (na.data?.baseTotalMinor ?? 0) - (nb.data?.baseTotalMinor ?? 0),
      },
    ],
    [],
  );

  if (phone) {
    return (
      <ul className="divide-y hairline">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/runs/${r.id}`} className="block min-h-11 px-4 py-3 active:bg-paper">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.name}</span>
                <span className="num shrink-0 whitespace-nowrap">{totalText(r)}</span>
              </span>
              <span className="mt-1 flex items-center gap-2">
                <span className="num min-w-0 truncate text-xs text-ink-soft">
                  {formatDate(r.createdAt)}, {r.progress} {r.status === "released" ? "" : r.count === 1 ? "payment" : "payments"}
                </span>
                <span className="ml-auto shrink-0">
                  <RunStatus status={r.status} label={r.statusLabel} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <DataGrid<RunRow>
      label="Payment runs"
      description="Newest first. Enter on a run name opens it."
      rowData={rows}
      columnDefs={columnDefs}
      defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }}
      getRowId={(p) => p.data.id}
      domLayout={rows.length <= 12 ? "autoHeight" : "normal"}
      height={480}
    />
  );
}
