"use client";

import { useState } from "react";
import type { TrialNotice as Notice } from "@/lib/studio/trial";

/** A pop-up for when the AG Studio trial licence has run out. The dashboard keeps working behind it. */
export function TrialNotice({ notice }: { notice: Notice }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="trial-notice-title">
      <div className="panel max-w-md p-5 shadow-xl">
        <h2 id="trial-notice-title" className="text-base font-semibold">AG Studio trial ended</h2>
        <p className="mt-2 text-ink-soft">
          The AG Studio trial expired {notice.label}. Please contact <a className="underline" href={`mailto:${notice.contact}`}>{notice.contact}</a> if it should be extended.
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
