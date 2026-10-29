"use client";

import { useState } from "react";

/** Tiny copy control for ids and hashes. Says "copied" in place for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="dense inline-flex h-5 items-center rounded px-1 text-ink-soft hover:text-ink pointer-coarse:-my-3 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard unavailable (insecure context). Nothing to do; the value is visible beside the button.
        }
      }}
    >
      {done ? (
        "copied"
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
    </button>
  );
}
