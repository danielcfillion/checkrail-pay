"use client";

import { useId, useRef, useState, type DragEvent } from "react";

/**
 * A dropzone around a real <input type="file">. The input stays in the tab order (visually hidden, not display:none),
 * so keyboard users focus the zone and press Enter or Space to choose; the label gives it its accessible name.
 * Dropped files are written back into the input, so a surrounding <form> submits them like a normal choice.
 */
export function FileDrop({
  name,
  accept,
  multiple = false,
  required = false,
  disabled = false,
  busy = null,
  label = "Drop a PDF or photo, or choose a file",
  hint,
  onFiles,
}: {
  name?: string;
  accept?: string;
  multiple?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** While uploading or reading: the line to show, for example "Sending trip-sheet.pdf". */
  busy?: string | null;
  label?: string;
  hint?: string;
  onFiles?: (files: FileList | null) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const off = disabled || Boolean(busy);

  const pick = (files: FileList | null) => {
    setNames(files ? Array.from(files).map((f) => f.name) : []);
    onFiles?.(files);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    if (off || !e.dataTransfer.files.length || !input.current) return;
    const dt = new DataTransfer();
    for (const f of Array.from(e.dataTransfer.files).slice(0, multiple ? undefined : 1)) dt.items.add(f);
    input.current.files = dt.files;
    pick(dt.files);
  };

  return (
    <div>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          if (!off) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`filedrop flex w-full items-center gap-3 rounded-md border border-dashed px-4 py-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--focus)] ${off ? "cursor-default" : "cursor-pointer hover:border-[color:var(--ink-soft)]"}`}
        style={{ borderColor: over ? "var(--focus)" : "var(--rule-strong)", background: over ? "var(--paypal-soft)" : "var(--sheet)" }}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-paper text-ink-soft" aria-hidden>
          {busy ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="animate-spin motion-reduce:animate-none">
              <circle cx="9" cy="9" r="7" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
              <path d="M16 9a7 7 0 0 0-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : names.length ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
              <path d="M4.5 2h6L14 5.5V16h-9.5z" />
              <path d="M10.5 2v3.5H14" />
              <path d="M7 11l1.6 1.6L11.5 9.5" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
              <path d="M9 11.5V3M5.75 6.25 9 3l3.25 3.25" />
              <path d="M3 11.5v3h12v-3" />
            </svg>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{busy ?? (names.length ? names.join(", ") : label)}</span>
          <span id={`${id}-hint`} className="block text-xs text-ink-soft">
            {busy ? "Keep this page open." : names.length ? "Choose again to replace." : hint}
          </span>
          {busy ? (
            <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-paper" role="progressbar" aria-label={busy}>
              <span className="filedrop-bar block h-full w-1/3 rounded-full" style={{ background: "var(--ink-soft)" }} />
            </span>
          ) : null}
        </span>
        {!busy ? <span className="btn btn-sm shrink-0" aria-hidden>{names.length ? "Change" : "Choose file"}</span> : null}
        <input
          ref={input}
          id={id}
          name={name}
          type="file"
          accept={accept}
          multiple={multiple}
          required={required}
          disabled={off}
          aria-describedby={`${id}-hint`}
          className="sr-only"
          onChange={(e) => pick(e.target.files)}
        />
      </label>
    </div>
  );
}
