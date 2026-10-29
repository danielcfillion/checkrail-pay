"use client";

import { useCallback, useId, useMemo } from "react";
import { useGridFilter, type CustomFilterProps } from "ag-grid-react";
import type { IDoesFilterPassParams } from "ag-grid-community";

/** Model: the keys a row may have to pass. null means no filter. */
export type ChoiceModel = { values: string[] } | null;

export type ChoiceFilterParams = { choices: Array<{ key: string; label: string }> };

/**
 * A tick-list column filter (rail, reconciled state, decided by), built on AG Grid's community custom filter
 * API: the enterprise Set filter is not used. The column's value is the key; labels are what people read.
 */
export function ChoiceFilter(props: CustomFilterProps & ChoiceFilterParams) {
  const { model, onModelChange, getValue, choices } = props;
  const id = useId();
  const picked = useMemo(() => new Set<string>(model?.values ?? choices.map((c) => c.key)), [model, choices]);

  const doesFilterPass = useCallback(
    ({ node }: IDoesFilterPassParams) => {
      if (!model) return true;
      const v = getValue(node);
      return model.values.includes(String(v ?? ""));
    },
    [model, getValue],
  );
  useGridFilter({ doesFilterPass });

  const set = (next: Set<string>) => onModelChange(next.size === choices.length ? null : { values: choices.map((c) => c.key).filter((k) => next.has(k)) });
  const toggle = (k: string) => {
    const n = new Set(picked);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    set(n);
  };

  return (
    <fieldset className="min-w-44 p-3 text-sm">
      <legend className="sr-only">Show rows where {String(props.colDef.headerName ?? "this column").toLowerCase()} is</legend>
      <ul className="space-y-1.5">
        {choices.map((c) => (
          <li key={c.key}>
            <label className="flex cursor-pointer items-center gap-2" htmlFor={`${id}-${c.key}`}>
              <input id={`${id}-${c.key}`} type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
              <span>{c.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2 border-t pt-2 hairline">
        <button type="button" className="btn btn-sm" onClick={() => set(new Set(choices.map((c) => c.key)))}>
          Show all
        </button>
      </div>
    </fieldset>
  );
}
