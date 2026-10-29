"use client";

import { useEffect, useId, useRef, useState } from "react";
import { formatDate, parseDateInput } from "@/lib/format";

/**
 * A date field that reads "29 Oct 2026" and stores ISO (DS2-17). The text box accepts what people type
 * ("29 Oct 2026", "29/10/2026", "2026-10-29"); the calendar button opens the browser's own picker. `value` and
 * `onChange` are ISO dates ("" for none), so callers keep their existing state.
 */
export function DateField({ id, value, onChange, disabled = false, required = false, className = "", style, "aria-label": ariaLabel }: { id?: string; value: string; onChange: (iso: string) => void; disabled?: boolean; required?: boolean; className?: string; style?: React.CSSProperties; "aria-label"?: string }) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [text, setText] = useState(value ? formatDate(value) : "");
  const [bad, setBad] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // A new value from outside (a reset, a picker choice) shows in words.
  useEffect(() => {
    setText(value ? formatDate(value) : "");
    setBad(false);
  }, [value]);

  const commit = (t: string) => {
    if (!t.trim()) {
      setBad(false);
      if (value) onChange("");
      return;
    }
    const iso = parseDateInput(t);
    if (!iso) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(formatDate(iso));
    if (iso !== value) onChange(iso);
  };

  return (
    <span className={`relative inline-flex items-center ${className}`} style={{ width: "10.5rem", ...style }}>
      <input
        id={inputId}
        type="text"
        inputMode="text"
        autoComplete="off"
        className="field num pr-9"
        placeholder="29 Oct 2026"
        value={text}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-invalid={bad || undefined}
        aria-describedby={bad ? `${inputId}-err` : undefined}
        style={bad ? { borderColor: "var(--blocked)" } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit((e.target as HTMLInputElement).value);
          }
        }}
      />
      <button
        type="button"
        className="date-pick absolute right-0 top-0 flex h-full w-8 items-center justify-center text-ink-soft hover:text-ink disabled:opacity-50"
        aria-label={`Pick a date${ariaLabel ? ` for ${ariaLabel.toLowerCase()}` : ""}`}
        disabled={disabled}
        onClick={() => {
          const p = picker.current;
          if (!p) return;
          try {
            p.showPicker();
          } catch {
            p.focus();
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <rect x="2.5" y="3.5" width="11" height="10" rx="1" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
        </svg>
      </button>
      {/* The browser's picker, out of the tab order; it writes back through onChange. */}
      <input ref={picker} type="date" tabIndex={-1} aria-hidden className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      {bad ? (
        <span id={`${inputId}-err`} role="alert" className="absolute left-0 top-full mt-0.5 whitespace-nowrap text-xs text-blocked">
          Type a date like 29 Oct 2026
        </span>
      ) : null}
    </span>
  );
}
