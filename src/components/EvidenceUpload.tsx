"use client";

import { useState, useTransition } from "react";
import { submitEvidenceAction } from "@/app/evidence/actions";

export function EvidenceUpload({ token }: { token: string }) {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done) return <p className="panel p-5">{done}</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await submitEvidenceAction(token, fd);
          if (r.ok) setDone(r.message);
          else setError(r.message);
        });
      }}
    >
      <input name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="field" required />
      <p className="text-xs text-ink-soft">PDF or a clear photo, 10 MB at most.</p>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending" : "Send document"}
      </button>
      {error ? <p className="text-attention">{error}</p> : null}
    </form>
  );
}
