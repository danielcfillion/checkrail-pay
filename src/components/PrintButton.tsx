"use client";

/** Opens the browser's print dialog, where "Save as PDF" is one of the destinations. */
export function PrintButton({ label = "Save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-sm no-print" onClick={() => window.print()}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 1.75v7M4.25 6 7 8.75 9.75 6" />
        <path d="M2.25 9.5v2.75h9.5V9.5" />
      </svg>
      {label}
    </button>
  );
}
