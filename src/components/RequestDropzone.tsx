"use client";

import { useId, useState, type DragEvent } from "react";

/**
 * A full-width drop target for the intake form: drop a PDF invoice or job sheet, or choose one.
 * Self-contained (no shared FileDrop), so it can change without touching the vendor evidence page.
 */
export function RequestDropzone({ onFiles, reading, note, accept }: { onFiles: (files: File[]) => void; reading: string | null; note?: string | null; accept: string }) {
  const id = useId();
  const [over, setOver] = useState(false);
  const busy = reading !== null;

  const take = (list: FileList | null) => {
    if (!list || list.length === 0 || busy) return;
    onFiles(Array.from(list));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files);
  };

  return (
    <div>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        aria-busy={busy}
        className={`flex w-full min-w-0 cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--focus)] flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-center transition-colors motion-reduce:transition-none ${busy ? "cursor-default" : "hover:bg-[color:var(--paper)]"}`}
        style={{ borderColor: over ? "var(--ink)" : "var(--rule-strong)", background: over ? "var(--paper)" : undefined }}
      >
        {busy ? (
          <>
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-[color:var(--rule-strong)] border-t-[color:var(--ink)] motion-reduce:animate-none" aria-hidden />
            <span className="font-medium" role="status">
              Reading <span className="num break-all">{reading}</span>
            </span>
            <span className="text-xs text-ink-soft">The figures it finds appear below for you to check.</span>
          </>
        ) : (
          <>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-soft">
              <path d="M8 4h8l6 6v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
              <path d="M16 4v6h6" />
              <path d="M14 20v-7M11 16l3-3 3 3" />
            </svg>
            <span className="font-medium">
              Drop a PDF invoice or job sheet, or <span className="link">choose a file</span>
            </span>
            <span className="max-w-xl text-xs text-ink-soft">PDFs are read from their text. Photos and scans need the Claude reader. Anything you type or change afterwards is marked as entered by you.</span>
          </>
        )}
        <input
          id={id}
          type="file"
          className="sr-only"
          accept={accept}
          multiple
          disabled={busy}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {note ? <p className="mt-2 text-xs">{note}</p> : null}
    </div>
  );
}
