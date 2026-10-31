"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { AgGridReact, CustomCellRendererProps } from "ag-grid-react";
import type { ColDef, IRowNode } from "ag-grid-community";
import { markCallAction } from "@/app/onboarding/actions";
import { useToast } from "@/components/Toast";
import { TonePill } from "@/components/ui";
import { DataGrid, GridSearch, usePhone } from "@/components/grid/DataGrid";
import { MoneyCell } from "@/components/grid/cells";
import { formatDateTime, formatMoney, humaniseActor, pluralise } from "@/lib/format";
import type { CallRow } from "@/lib/onboarding/dashboard";
import { CHIPS, CHIP_LABEL, MARK_LABEL, chipCounts, defaultChip, markProgress, matchesChip, verdictLabel, withMarks, type CallChip, type CallSummary, type Mark } from "./calibrate-model";
import { shortDate } from "./import-model";

/* .btn is plain CSS outside Tailwind's layers, so a utility class cannot restyle it: the on states go inline.
   Neither is a status colour: a chosen filter is ink on a neutral tint, a chosen mark the cobalt of a decision. */
const CHIP_ON = { background: "var(--neutral-soft)", borderColor: "var(--ink)", fontWeight: 600 } as const;
const MARK_ON = { background: "var(--action-soft)", borderColor: "var(--action)", color: "var(--action)", fontWeight: 600 } as const;

interface Ctx {
  canMark: boolean;
  onMark: (row: CallRow, mark: Mark) => void;
}

/** A call as the grid holds it: busy while its mark is being saved, so only that row redraws. */
type GridRow = CallRow & { busy?: boolean };

/**
 * The figures and the calls of "Check our calls". The money that would have been stopped leads; then every call the
 * re-check made that a person should look at, each marked "Right catch" or "Was fine". A mark is a note for Checkrail;
 * it never changes a rule.
 */
export function CallsBoard({ rows: serverRows, summary, canMark }: { rows: CallRow[]; summary: CallSummary; canMark: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const phone = usePhone();
  const grid = useRef<AgGridReact<GridRow>>(null);
  const [overrides, setOverrides] = useState<Record<string, Mark>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, startRefresh] = useTransition();
  const rows = useMemo(() => withMarks(serverRows, overrides), [serverRows, overrides]);
  // A new object for the busy row only: the grid keeps every other row as it is.
  const gridRows = useMemo<GridRow[]>(() => rows.map((r) => (r.call_id === busy ? { ...r, busy: true } : r)), [rows, busy]);
  const [chip, setChip] = useState<CallChip>(() => defaultChip(serverRows));
  const [search, setSearch] = useState("");
  const counts = chipCounts(rows);
  const progress = markProgress(rows);

  const onMark = useCallback(
    async (row: CallRow, mark: Mark) => {
      if (row.mark === mark) return;
      setBusy(row.call_id);
      const res = await markCallAction(row.call_id, mark);
      setBusy(null);
      if (!res.ok) {
        toast(res.message, "error");
        return;
      }
      setOverrides((o) => ({ ...o, [row.call_id]: mark }));
      toast(`${res.message} ${row.payee}, ${formatMoney(row.amount_minor, row.currency)}.`);
      // The suggestions and the figures are worked out on the server from the marks.
      startRefresh(() => router.refresh());
    },
    [router, toast],
  );

  const context = useMemo<Ctx>(() => ({ canMark, onMark }), [canMark, onMark]);

  // A chip is an external filter: re-run it when the chip changes. Row changes re-run it on their own.
  useEffect(() => {
    grid.current?.api?.onFilterChanged();
  }, [chip]);

  const columnDefs = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        colId: "date",
        field: "date",
        headerName: "Date",
        width: 116,
        cellClass: "cr-soft",
        valueFormatter: (p) => shortDate(p.value),
        getQuickFilterText: (p) => shortDate(p.value),
      },
      {
        colId: "payee",
        field: "payee",
        headerName: "Payee and reference",
        flex: 1.4,
        minWidth: 200,
        getQuickFilterText: (p) => `${p.value ?? ""} ${p.data?.reference ?? ""}`,
        cellRenderer: (p: CustomCellRendererProps<GridRow>) =>
          p.data ? (
            <span className="block min-w-0 leading-5" title={p.data.reference ? `${p.data.payee}, ${p.data.reference}` : p.data.payee}>
              <span className="block truncate font-medium">{p.data.payee}</span>
              <span className="mono block truncate text-[12px] text-ink-soft">{p.data.reference ?? "no reference"}</span>
            </span>
          ) : null,
      },
      {
        colId: "amount",
        field: "amount_minor",
        headerName: "Amount",
        width: 150,
        type: "rightAligned",
        headerClass: "cr-right",
        cellClass: "cr-right",
        getQuickFilterText: (p) => (p.data ? formatMoney(p.data.amount_minor, p.data.currency) : ""),
        cellRenderer: (p: CustomCellRendererProps<GridRow>) => (p.data ? <MoneyCell minor={p.data.amount_minor} currency={p.data.currency} /> : null),
      },
      {
        colId: "verdict",
        field: "verdict",
        headerName: "Call",
        width: 96,
        getQuickFilterText: (p) => verdictLabel(p.value),
        cellRenderer: (p: CustomCellRendererProps<GridRow>) => (p.data ? <VerdictPill verdict={p.data.verdict} /> : null),
      },
      {
        colId: "reason",
        field: "reason",
        headerName: "Why",
        flex: 2,
        minWidth: 240,
        sortable: false,
        getQuickFilterText: (p) => `${p.data?.category_label ?? ""} ${p.value ?? ""}`,
        cellRenderer: (p: CustomCellRendererProps<GridRow>) =>
          p.data ? (
            // Two lines fit the row; a longer reason is whole on hover.
            <span className="line-clamp-2 whitespace-normal leading-5" title={whyText(p.data)}>
              <Why row={p.data} />
            </span>
          ) : null,
      },
      {
        colId: "mark",
        field: "mark",
        headerName: "Was it right?",
        width: 224,
        sortable: false,
        getQuickFilterText: (p) => (p.value ? MARK_LABEL[p.value as Mark] : "unmarked"),
        cellRenderer: (p: CustomCellRendererProps<GridRow, unknown, Ctx>) => (p.data ? <MarkButtons row={p.data} ctx={p.context} /> : null),
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<GridRow>>(() => ({ sortable: true, resizable: true, suppressHeaderMenuButton: true, filter: false }), []);
  const isExternalFilterPresent = useCallback(() => chip !== "all", [chip]);
  const doesExternalFilterPass = useCallback((n: IRowNode<GridRow>) => (n.data ? matchesChip(n.data, chip) : true), [chip]);

  const cardRows = useMemo(() => rows.filter((r) => matchesChip(r, chip) && (!search || `${r.payee} ${r.reference ?? ""} ${r.reason} ${r.category_label}`.toLowerCase().includes(search.toLowerCase()))), [rows, chip, search]);

  return (
    <>
      <dl className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Figure
          hero
          label="Errors it would have caught"
          value={formatMoney(summary.stoppedMinor, summary.currency)}
          note={`paid twice or over the job record; ${pluralise(summary.blocked, "payment")} blocked in all`}
        />
        <Figure label="Held for a person" value={String(summary.held)} note="no rule broken, but someone should look" tone={summary.held ? "attention" : undefined} />
        <Figure label="Clear" value={String(summary.clear)} note={`of ${pluralise(summary.payments, "payment")}, every rule passed`} tone={summary.clear ? "settled" : undefined} />
        <div className="panel min-w-0 px-5 py-4 sm:px-6 sm:py-5">
          <dt className="text-[13px] text-ink-soft">Your marks</dt>
          <dd className="wide num mt-1.5 text-[28px] leading-[34px] sm:text-[32px] sm:leading-[38px]">
            {progress.marked} <span className="text-ink-soft">of {progress.total}</span>
          </dd>
          <dd className="mt-3">
            <span className="block h-1.5 w-full overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-label="Calls marked" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.marked}>
              <span className="block h-full rounded-full" style={{ width: `${Math.round(progress.share * 100)}%`, background: "var(--ink)" }} />
            </span>
          </dd>
        </div>
      </dl>
      {summary.otherCurrencies.length ? <p className="dense -mt-3 mb-6 text-ink-soft">Figures are for {summary.currency}. Re-checks in {summary.otherCurrencies.join(", ")} are listed below with their own amounts.</p> : null}

      <section className="panel min-w-0" aria-labelledby="calls-title">
        <div className="flex flex-wrap items-end justify-between gap-4 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <h2 id="calls-title" className="text-lg font-semibold">
              Checkrail&apos;s calls
            </h2>
            <p className="mt-0.5 text-ink-soft">{canMark ? "Was each one right? Mark it, and change a mark any time." : "An approver or the owner marks the calls."}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div role="group" aria-label="Show calls" className="flex flex-wrap items-center gap-1.5">
              {CHIPS.map((c) => (
                <button key={c} type="button" className="btn btn-sm" style={chip === c ? CHIP_ON : undefined} aria-pressed={chip === c} onClick={() => setChip(c)}>
                  {CHIP_LABEL[c]}
                  <span className="num opacity-70">{counts[c]}</span>
                </button>
              ))}
            </div>
            <GridSearch value={search} onChange={setSearch} label="Search the calls" placeholder="Payee, reference, reason" />
          </div>
        </div>
        {phone ? (
          <CallCards rows={cardRows.map((r) => (r.call_id === busy ? { ...r, busy: true } : r))} ctx={context} />
        ) : (
          <DataGrid<GridRow>
            ref={grid}
            label="Checkrail's calls on your past payments"
            description="Each row is a past payment the re-check would have blocked or held. The last column marks it right catch or was fine. Use the arrow keys to move between cells and Tab to reach the buttons."
            rowData={gridRows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            context={context}
            getRowId={(p) => p.data.call_id}
            rowHeight={64}
            quickFilterText={search}
            isExternalFilterPresent={isExternalFilterPresent}
            doesExternalFilterPass={doesExternalFilterPass}
            height={Math.min(38 + 64 * Math.max(counts[chip], 1) + 4, 620)}
            overlayNoRowsTemplate="<span>No calls here. Pick another filter above.</span>"
          />
        )}
      </section>
    </>
  );
}

/** The reason, led by what kind of block it was. A hold needs no lead: the pill already says Held. */
function Why({ row }: { row: CallRow }) {
  return row.verdict === "block" ? (
    <>
      <span className="font-medium">{row.category_label}.</span> <span className="text-ink-soft">{row.reason}</span>
    </>
  ) : (
    <span className="text-ink-soft">{row.reason}</span>
  );
}

const whyText = (r: CallRow) => (r.verdict === "block" ? `${r.category_label}. ${r.reason}` : r.reason);

function VerdictPill({ verdict }: { verdict: string }) {
  return <TonePill tone={verdict === "block" ? "blocked" : verdict === "hold" ? "attention" : "settled"}>{verdictLabel(verdict)}</TonePill>;
}

function MarkButtons({ row, ctx }: { row: GridRow; ctx: Ctx }) {
  const busy = Boolean(row.busy);
  if (!ctx.canMark) {
    return row.mark ? <span>{MARK_LABEL[row.mark as Mark]}</span> : <span className="text-ink-soft">Not marked</span>;
  }
  const who = row.marked_by ? `Marked by ${humaniseActor(row.marked_by)}${row.marked_at ? `, ${formatDateTime(row.marked_at)}` : ""}` : undefined;
  return (
    <span className="flex items-center gap-1.5 py-2" role="group" aria-label={`Mark the call on ${row.payee}`} title={who}>
      {(["right_catch", "was_fine"] as const).map((m) => {
        const on = row.mark === m;
        return (
          <button
            key={m}
            type="button"
            className="btn btn-sm"
            style={on ? MARK_ON : undefined}
            aria-pressed={on}
            disabled={busy}
            onClick={() => ctx.onMark(row, m)}
          >
            {on ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                <path d="M3.25 6.25l1.9 1.9L8.9 4.2" />
              </svg>
            ) : null}
            {MARK_LABEL[m]}
          </button>
        );
      })}
    </span>
  );
}

/** Phones: one card per call, the mark buttons under the reason. */
function CallCards({ rows, ctx }: { rows: GridRow[]; ctx: Ctx }) {
  if (!rows.length) return <p className="px-5 pb-6 text-ink-soft">No calls here. Pick another filter above.</p>;
  return (
    <ul className="divide-y hairline border-t hairline">
      {rows.map((r) => (
        <li key={r.call_id} className="px-4 py-3">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">{r.payee}</span>
            <MoneyCell minor={r.amount_minor} currency={r.currency} />
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="num text-xs text-ink-soft">{shortDate(r.date)}</span>
            {r.reference ? <span className="mono truncate text-xs text-ink-soft">{r.reference}</span> : null}
            <span className="ml-auto">
              <VerdictPill verdict={r.verdict} />
            </span>
          </span>
          <p className="mt-2">
            <Why row={r} />
          </p>
          <MarkButtons row={r} ctx={ctx} />
        </li>
      ))}
    </ul>
  );
}

function Figure({ label, value, note, tone, hero = false }: { label: string; value: string; note?: string; tone?: "attention" | "settled"; hero?: boolean }) {
  const colour = tone === "attention" ? "text-attention" : tone === "settled" ? "text-settled" : "";
  return (
    <div className={`panel min-w-0 px-5 py-4 sm:px-6 sm:py-5 ${hero ? "panel-hero" : ""}`}>
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className={`wide num mt-1.5 break-words text-[24px] leading-[30px] sm:text-[28px] sm:leading-[34px] ${colour}`}>{value}</dd>
      {note ? <dd className="mt-1 text-[13px] leading-[18px] text-ink-soft">{note}</dd> : null}
    </div>
  );
}
