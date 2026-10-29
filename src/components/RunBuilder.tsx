"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AgGridReact, CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, IRowNode, SelectionChangedEvent } from "ag-grid-community";
import { createRunAction } from "@/app/actions";
import { formatDate, formatMoney, pluralise } from "@/lib/format";
import { useToast } from "./Toast";
import { DataGrid, FilterChips, GridSearch, usePhone } from "./grid/DataGrid";
import { CellLink, MoneyCell, RailCell } from "./grid/cells";
import { dueByIds, fundingByRail, type PayableRow } from "./grid/model";

const NO_RAIL = "__none";

/**
 * Tick what is due, see what each rail needs funded, make a run. The grid only chooses rows: the run itself is
 * made by the existing createRunAction, which re-checks every id on the server.
 */
export function RunBuilder({ rows, defaultName }: { rows: PayableRow[]; defaultName: string }) {
  const phone = usePhone();
  const gridRef = useRef<AgGridReact<PayableRow>>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.filter((r) => !r.scheduled).map((r) => r.id)));
  const [name, setName] = useState(defaultName);
  const [dueBy, setDueBy] = useState("");
  const [rail, setRail] = useState<string>("all");
  const [group, setGroup] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const pickedRows = useMemo(() => rows.filter((r) => picked.has(r.id)), [rows, picked]);
  const funding = useMemo(() => fundingByRail(pickedRows), [pickedRows]);

  const railOptions = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number }>();
    for (const r of rows) {
      const k = r.rail ?? NO_RAIL;
      const o = m.get(k) ?? { key: k, label: r.railLabel, count: 0 };
      o.count += 1;
      m.set(k, o);
    }
    return [...m.values()];
  }, [rows]);

  const railOf = (r: PayableRow) => r.rail ?? NO_RAIL;
  const visibleRows = useMemo(() => rows.filter((r) => rail === "all" || railOf(r) === rail), [rows, rail]);

  /* Keep the grid's checkboxes and our set in step, whichever side changed. */
  const syncing = useRef(false);
  const applyToGrid = useCallback((ids: Set<string>) => {
    const api = gridRef.current?.api;
    if (!api) return;
    syncing.current = true;
    const yes: IRowNode<PayableRow>[] = [];
    const no: IRowNode<PayableRow>[] = [];
    api.forEachNode((n) => (n.data && ids.has(n.data.id) ? yes : no).push(n));
    api.setNodesSelected({ nodes: no, newValue: false, source: "api" });
    api.setNodesSelected({ nodes: yes, newValue: true, source: "api" });
    syncing.current = false;
  }, []);

  const onSelectionChanged = (e: SelectionChangedEvent<PayableRow>) => {
    if (syncing.current || e.source === "api") return;
    setPicked(new Set(e.api.getSelectedRows().map((r) => r.id)));
  };

  // Choosing a rail keeps only that rail's rows ticked, so the run is exactly what is on screen.
  const chooseRail = (k: string) => {
    setRail(k);
    if (k !== "all") {
      const next = new Set([...picked].filter((id) => railOf(rows.find((r) => r.id === id)!) === k));
      setPicked(next);
      applyToGrid(next);
    }
  };

  const pickDueBy = (d: string) => {
    setDueBy(d);
    if (!d) return;
    const next = new Set(dueByIds(visibleRows, d));
    setPicked(next);
    applyToGrid(next);
  };

  useEffect(() => {
    gridRef.current?.api?.onFilterChanged("api");
  }, [rail]);

  const columnDefs = useMemo<ColDef<PayableRow>[]>(
    () => [
      {
        colId: "rail",
        field: "railLabel",
        headerName: "Rail",
        width: 130,
        spanRows: group,
        sort: group ? "asc" : undefined,
        cellRenderer: (p: CustomCellRendererProps<PayableRow>) => (p.data ? <RailCell rail={p.data.rail} /> : null),
      },
      {
        colId: "vendorName",
        field: "vendorName",
        headerName: "Vendor",
        minWidth: 160,
        flex: 1.3,
        cellRenderer: (p: CustomCellRendererProps<PayableRow>) =>
          p.data ? (
            <CellLink href={`/obligations/${p.data.id}`} label={`Open request from ${p.data.vendorName}`}>
              {p.data.vendorName}
            </CellLink>
          ) : null,
      },
      { colId: "sourceRef", field: "sourceRef", headerName: "Reference", minWidth: 140, flex: 1, cellClass: "cr-soft", valueFormatter: (p) => p.value || "none" },
      {
        colId: "dueDate",
        field: "dueDate",
        headerName: "Due",
        width: 124,
        sort: group ? undefined : "asc",
        comparator: (a: string | null, b: string | null) => (a ?? "9999").localeCompare(b ?? "9999"),
        valueFormatter: (p) => (p.value ? formatDate(p.value) : "none"),
        cellClassRules: { "cr-overdue": (p) => Boolean(p.data?.overdue), "cr-soft": (p) => !p.data?.overdue },
        tooltipValueGetter: (p) => (p.data?.overdue ? "Past its due date" : undefined),
      },
      { colId: "status", field: "statusLabel", headerName: "Status", minWidth: 170, flex: 1, cellClass: "cr-soft" },
      {
        colId: "amountMinor",
        field: "amountMinor",
        headerName: "Amount",
        width: 160,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right",
        comparator: (_a, _b, na, nb) => (na.data?.baseMinor ?? 0) - (nb.data?.baseMinor ?? 0),
        getQuickFilterText: (p) => (p.data ? formatMoney(p.data.amountMinor, p.data.currency) : ""),
        cellRenderer: (p: CustomCellRendererProps<PayableRow>) => (p.data ? <MoneyCell minor={p.data.amountMinor} currency={p.data.currency} /> : null),
      },
    ],
    [group],
  );

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createRunAction(name, [...picked]);
      toast(r.message, r.ok ? "ok" : "error");
      if (r.ok && r.id) router.push(`/runs/${r.id}`);
    });
  };

  const noDue = visibleRows.filter((r) => !r.dueDate).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
        <label>
          <span className="lbl">Pick everything due by</span>
          <input type="date" className="field num" value={dueBy} onChange={(e) => pickDueBy(e.target.value)} />
        </label>
        {!phone ? <GridSearch value={search} onChange={setSearch} label="Search payable requests" placeholder="Vendor or reference" /> : null}
        {railOptions.length > 1 ? <FilterChips label="Rail" options={railOptions} value={rail} onChange={chooseRail} /> : null}
        {!phone && railOptions.length > 1 ? (
          <label className="flex items-center gap-2 pb-1.5">
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
            <span>Group by rail</span>
          </label>
        ) : null}
      </div>
      {dueBy && noDue ? <p className="-mt-2 text-xs text-ink-soft">{noDue} without a due date are not picked</p> : null}

      {phone ? (
        <PayableCards rows={visibleRows} picked={picked} onToggle={(id) => setPicked((p) => toggled(p, id))} />
      ) : (
        <DataGrid<PayableRow>
          ref={gridRef}
          className="overflow-hidden rounded border hairline"
          label="Payable requests"
          description="Tick the payments to include. Space ticks the focused row; the header box ticks every row shown. Enter on a vendor opens the request."
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true }}
          getRowId={(p) => p.data.id}
          rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "filtered", enableClickSelection: false }}
          selectionColumnDef={{ width: 48, pinned: "left", headerTooltip: "Select every row shown" }}
          enableCellSpan
          quickFilterText={search}
          isExternalFilterPresent={() => rail !== "all"}
          doesExternalFilterPass={(n) => Boolean(n.data && railOf(n.data) === rail)}
          onFirstDataRendered={() => applyToGrid(picked)}
          onSelectionChanged={onSelectionChanged}
          domLayout={rows.length <= 12 ? "autoHeight" : "normal"}
          height={520}
          overlayNoRowsTemplate="<span>Nothing on this rail. Choose All to see every payable request.</span>"
        />
      )}

      <FundingSummary funding={funding} />

      <form className="flex flex-wrap items-end gap-3" onSubmit={create}>
        <div>
          <label className="lbl" htmlFor="run-name">
            Run name
          </label>
          <input id="run-name" className="field" style={{ width: "14rem" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <p className="num pb-2" aria-live="polite">
          {picked.size} selected{funding.totals.length ? `, ${funding.totals.map((t) => formatMoney(t.minor, t.currency)).join(" + ")}` : ""}
        </p>
        <button type="submit" className="btn btn-primary" disabled={pending || picked.size === 0}>
          {pending ? "Creating" : "Create run"}
        </button>
      </form>
    </div>
  );
}

function toggled(p: Set<string>, id: string): Set<string> {
  const n = new Set(p);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

/** What the approver has to fund before release, per rail and currency, updated as rows are ticked. */
function FundingSummary({ funding }: { funding: ReturnType<typeof fundingByRail> }) {
  if (!funding.count) return <p className="text-ink-soft">Nothing selected. Tick the payments this run should carry.</p>;
  return (
    <section aria-label="Funding for this selection" className="rounded border px-4 py-3 hairline">
      <h3 className="dense text-ink-soft">To fund before release</h3>
      <ul className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
        {funding.byRail.map((f) => (
          <li key={f.rail ?? "none"} className="flex items-baseline gap-2">
            <RailCell rail={f.rail} />
            <span className="num font-medium">{f.totals.map((t) => formatMoney(t.minor, t.currency)).join(" + ")}</span>
            <span className="dense text-ink-soft">{pluralise(f.count, "payment")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Phones: one tappable row per request with its own checkbox, as the rest of the app does below 640px. */
function PayableCards({ rows, picked, onToggle }: { rows: PayableRow[]; picked: Set<string>; onToggle: (id: string) => void }) {
  return (
    <ul className="divide-y rounded border hairline">
      {rows.map((r) => (
        <li key={r.id} className="flex items-start gap-3 px-3 py-3">
          <input type="checkbox" className="mt-1 size-5 shrink-0" aria-label={`Include ${r.vendorName}${r.sourceRef ? `, ${r.sourceRef}` : ""}`} checked={picked.has(r.id)} onChange={() => onToggle(r.id)} />
          <div className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-3">
              <Link href={`/obligations/${r.id}`} className="min-w-0 truncate font-medium">
                {r.vendorName}
              </Link>
              <MoneyCell minor={r.amountMinor} currency={r.currency} />
            </span>
            <span className="mt-1 flex items-center gap-2">
              <span className={`num min-w-0 truncate text-xs ${r.overdue ? "text-attention" : "text-ink-soft"}`}>
                {r.sourceRef || "no reference"}, due {r.dueDate ? formatDate(r.dueDate) : "none"}
              </span>
              <span className="ml-auto shrink-0">
                <RailCell rail={r.rail} />
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-ink-soft">{r.statusLabel}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
