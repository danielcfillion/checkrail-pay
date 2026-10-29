"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import type { AgGridReact, CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, GridState, ICellRendererParams, IDateFilterParams, ProcessCellForExportParams, ValueFormatterParams } from "ag-grid-community";
import { formatDateTime, formatMoney, localDateString, pluralise } from "@/lib/format";
import { DataGrid, GridSearch, readGridState, usePhone, writeGridState } from "./DataGrid";
import { CellLink, DecidedCell, MoneyCell, RailCell, ReconPill } from "./cells";
import { ChoiceFilter, type ChoiceFilterParams } from "./ChoiceFilter";
import { compareDayToIso, displayDate, LEDGER_CSV_COLUMNS, ledgerCsvValue, ledgerTotals, RECON_LABEL, totalRowsFor, type LedgerRow, type LedgerTotalRow, type ReconState } from "./model";
import { ledgerCsv, LEDGER_CSV_HEADERS } from "./csv";

const STATE_KEY = "cr-grid:ledger:v1";
type Row = LedgerRow | LedgerTotalRow;
const isTotal = (r: Row | undefined): r is LedgerTotalRow => Boolean(r && "totalOf" in r);

/** Download a CSV string as a file (used by the phone fallback, which has no grid to export from). */
function download(csv: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The settlements ledger. Sort any column (amounts sort by value at reference rates, dates by ISO), filter from
 * the header menus, search everything at once, and export what is on screen as CSV. The pinned rows total the
 * visible rows per currency and follow every filter.
 */
export function LedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const phone = usePhone();
  const gridRef = useRef<AgGridReact<Row>>(null);
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState<LedgerRow[]>(rows);
  const [initialState] = useState<GridState | undefined>(() => readGridState<GridState>(STATE_KEY));

  const fileName = `checkrail-pay-ledger-${localDateString()}.csv`;

  const railChoices = useMemo(() => uniqueChoices(rows.map((r) => [r.rail, r.railLabel])), [rows]);
  const decidedChoices = useMemo(() => uniqueChoices(rows.map((r) => [r.decidedBy, r.decidedBy])), [rows]);
  const reconChoices = useMemo(() => (Object.keys(RECON_LABEL) as ReconState[]).map((k) => ({ key: k, label: RECON_LABEL[k] })), []);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: "settledAt",
        field: "settledAt",
        headerName: "Settled",
        width: 112,
        sort: initialState?.sort ? undefined : "desc",
        cellClass: "cr-soft",
        valueFormatter: (p: ValueFormatterParams<Row>) => displayDate(p.value),
        tooltipValueGetter: (p) => (p.data && !isTotal(p.data) ? formatDateTime(p.data.settledAt) : undefined),
        getQuickFilterText: (p) => displayDate(p.value),
        filter: "agDateColumnFilter",
        filterParams: { comparator: compareDayToIso, buttons: ["clear"], maxNumConditions: 1 } satisfies IDateFilterParams,
      },
      {
        colId: "vendorName",
        field: "vendorName",
        headerName: "Vendor",
        minWidth: 140,
        flex: 1.4,
        // A totals row's value carries its count, so the cell redraws when a filter changes the count.
        valueGetter: (p) => (isTotal(p.data) ? `${p.data.vendorName} (${p.data.totalOf})` : p.data?.vendorName),
        filter: "agTextColumnFilter",
        filterParams: { buttons: ["clear"], maxNumConditions: 1 },
        cellRenderer: (p: CustomCellRendererProps<Row>) =>
          isTotal(p.data) ? (
            <span>
              {p.data.vendorName} <span className="cr-total-label">{pluralise(p.data.totalOf, "payment")}</span>
            </span>
          ) : (
            <span className="font-medium">{p.value}</span>
          ),
      },
      {
        colId: "sourceRef",
        field: "sourceRef",
        headerName: "Reference",
        minWidth: 128,
        flex: 1,
        filter: "agTextColumnFilter",
        filterParams: { buttons: ["clear"], maxNumConditions: 1 },
        cellRenderer: (p: CustomCellRendererProps<Row>) =>
          !p.data || isTotal(p.data) ? null : (
            <CellLink href={`/obligations/${p.data.obligationId}`} label={`Open request ${p.data.sourceRef || p.data.vendorName}`}>
              {p.data.sourceRef || "no reference"}
            </CellLink>
          ),
      },
      {
        colId: "amountMinor",
        field: "amountMinor",
        headerName: "Amount",
        width: 124,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right",
        // Value sort across currencies: compared in the base currency at the server's reference rates.
        comparator: (_a, _b, na, nb) => (na.data?.baseMinor ?? 0) - (nb.data?.baseMinor ?? 0) || (na.data?.amountMinor ?? 0) - (nb.data?.amountMinor ?? 0),
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.amountMinor / 100 : null),
        filterParams: { buttons: ["clear"], maxNumConditions: 1, filterOptions: ["greaterThanOrEqual", "lessThanOrEqual", "equals", "inRange"] },
        getQuickFilterText: (p) => (p.data ? formatMoney(p.data.amountMinor, p.data.currency) : ""),
        cellRenderer: (p: ICellRendererParams<Row>) => (p.data ? <MoneyCell minor={p.data.amountMinor} currency={p.data.currency} /> : null),
      },
      {
        colId: "feeMinor",
        field: "feeMinor",
        headerName: "Fee",
        width: 96,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right cr-soft",
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.feeMinor / 100 : null),
        filterParams: { buttons: ["clear"], maxNumConditions: 1 },
        cellRenderer: (p: ICellRendererParams<Row>) => (p.data ? <MoneyCell minor={p.data.feeMinor} currency={p.data.currency} soft /> : null),
      },
      {
        colId: "receivedMinor",
        field: "receivedMinor",
        headerName: "Received",
        headerTooltip: "What the recipient received, in their currency",
        width: 148,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right",
        filter: false,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Row>) => (p.data ? isTotal(p.data) && p.data.receivedMinor === null ? <span className="cr-total-label" title="Recipients were paid in more than one currency">several currencies</span> : <MoneyCell minor={p.data.receivedMinor} currency={p.data.receivedCurrency} /> : null),
      },
      {
        colId: "rail",
        field: "rail",
        headerName: "Rail",
        width: 92,
        filter: ChoiceFilter,
        filterParams: { choices: railChoices } satisfies ChoiceFilterParams,
        getQuickFilterText: (p) => p.data?.railLabel ?? "",
        cellRenderer: (p: ICellRendererParams<Row>) => (!p.data || isTotal(p.data) ? null : <RailCell rail={p.data.rail} />),
      },
      {
        colId: "recon",
        field: "recon",
        headerName: "Reconciled",
        width: 144,
        filter: ChoiceFilter,
        filterParams: { choices: reconChoices } satisfies ChoiceFilterParams,
        getQuickFilterText: (p) => (p.data ? RECON_LABEL[p.data.recon] : ""),
        cellRenderer: (p: ICellRendererParams<Row>) => (!p.data || isTotal(p.data) ? null : <ReconPill state={p.data.recon} />),
      },
      {
        colId: "decidedBy",
        field: "decidedBy",
        headerName: "Decided by",
        width: 120,
        filter: ChoiceFilter,
        filterParams: { choices: decidedChoices } satisfies ChoiceFilterParams,
        cellRenderer: (p: ICellRendererParams<Row>) => (!p.data || isTotal(p.data) ? null : <DecidedCell kind={p.data.decidedKind} label={p.data.decidedBy} />),
      },
      // Exported, not shown: kept as columns so the CSV comes from the grid itself.
      { colId: "currency", field: "currency", headerName: "Currency", hide: true },
      { colId: "externalId", field: "externalId", headerName: "External id", hide: true },
      { colId: "statementRef", field: "statementRef", headerName: "Statement line", hide: true },
      { colId: "obligationId", field: "obligationId", headerName: "Request id", hide: true },
    ],
    [railChoices, decidedChoices, reconChoices, initialState],
  );

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ sortable: true, resizable: true, suppressHeaderMenuButton: true, filter: true, floatingFilter: false, suppressKeyboardEvent: undefined }), []);

  /** Totals and the live count follow whatever is visible after filters and search. */
  const refreshVisible = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    const out: LedgerRow[] = [];
    api.forEachNodeAfterFilterAndSort((n) => {
      if (n.data && !isTotal(n.data)) out.push(n.data);
    });
    setVisible(out);
  }, []);

  const pinned = useMemo(() => totalRowsFor(ledgerTotals(visible)), [visible]);

  const cardRows = useMemo(() => (search ? rows.filter((r) => matches(r, search)) : rows), [rows, search]);

  const exportCsv = () => {
    const api = gridRef.current?.api;
    if (phone || !api) return download(ledgerCsv(phone ? cardRows : visible), fileName);
    api.exportDataAsCsv({
      fileName,
      columnKeys: [...LEDGER_CSV_COLUMNS],
      exportedRows: "filteredAndSorted",
      skipPinnedBottom: true,
      processHeaderCallback: (p) => LEDGER_CSV_HEADERS[p.column.getColId()] ?? p.column.getColDef().headerName ?? p.column.getColId(),
      processCellCallback: (p: ProcessCellForExportParams<Row>) => (p.node?.data ? ledgerCsvValue(p.column.getColId(), p.node.data as LedgerRow) : ""),
    });
  };

  const shown = phone ? cardRows.length : visible.length;
  const status = shown !== rows.length ? `Showing ${shown} of ${pluralise(rows.length, "settlement")}` : pluralise(rows.length, "settlement");

  return (
    <div className="panel min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-3 hairline">
        <GridSearch value={search} onChange={setSearch} label="Search the ledger" placeholder="Vendor, reference, rail, amount" />
        <div className="flex items-center gap-3">
          <p className="dense text-ink-soft" aria-live="polite">
            {status}
          </p>
          <button type="button" className="btn" onClick={exportCsv} disabled={shown === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {phone ? (
        <LedgerCards rows={cardRows} />
      ) : (
        <DataGrid<Row>
          ref={gridRef}
          label="Settlements ledger"
          description="Sortable and filterable. Use the arrow keys to move between cells, Enter to open the request in the reference column, and the header menu to filter a column. The last rows total each currency for the rows shown."
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          quickFilterText={search}
          cacheQuickFilter
          pinnedBottomRowData={pinned}
          initialState={initialState}
          onStateUpdated={(e) => writeGridState(STATE_KEY, { sort: e.state.sort, filter: e.state.filter })}
          onFirstDataRendered={refreshVisible}
          onModelUpdated={refreshVisible}
          height={Math.min(36 + 40 * (rows.length + pinned.length) + 2, 640)}
          overlayNoRowsTemplate="<span>No settlements match. Clear the search or a column filter.</span>"
        />
      )}
    </div>
  );
}

function uniqueChoices(pairs: Array<[string, string]>): Array<{ key: string; label: string }> {
  const m = new Map<string, string>();
  for (const [k, l] of pairs) if (!m.has(k)) m.set(k, l);
  return [...m.entries()].map(([key, label]) => ({ key, label }));
}

function matches(r: LedgerRow, q: string): boolean {
  const hay = [r.vendorName, r.sourceRef, r.railLabel, RECON_LABEL[r.recon], r.decidedBy, displayDate(r.settledAt), formatMoney(r.amountMinor, r.currency)].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Phones: the two-line rows the rest of the app uses below 640px, whole row a tap target. */
function LedgerCards({ rows }: { rows: LedgerRow[] }) {
  const totals = ledgerTotals(rows);
  return (
    <>
      <ul className="divide-y hairline">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/obligations/${r.obligationId}`} className="block min-h-11 px-4 py-3 active:bg-paper">
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.vendorName}</span>
                <MoneyCell minor={r.amountMinor} currency={r.currency} />
              </span>
              <span className="mt-1 flex items-center gap-2">
                <span className="num min-w-0 truncate text-xs text-ink-soft">
                  {displayDate(r.settledAt)}, {r.sourceRef || "no reference"}
                </span>
                <RailCell rail={r.rail} />
                <span className="ml-auto shrink-0">
                  <ReconPill state={r.recon} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {totals.length ? (
        <ul className="border-t px-4 py-3 hairline" aria-label="Totals">
          {totals.map((t) => (
            <li key={t.currency} className="flex items-baseline justify-between gap-3 font-semibold">
              <span>
                Total {t.currency} <span className="dense font-medium text-ink-soft">{pluralise(t.count, "payment")}</span>
              </span>
              <span className="num">{formatMoney(t.amountMinor, t.currency)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-ink-soft">No settlements match the search.</p>
      )}
    </>
  );
}
