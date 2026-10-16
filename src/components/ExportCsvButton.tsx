"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { exportCsvAction } from "@/app/actions";
import { useToast } from "./Toast";

/** Export the pending records: downloads the CSV and marks them exported in one server action. */
export function ExportCsvButton({ pendingCount }: { pendingCount: number }) {
  const [busy, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (pendingCount === 0) {
    return (
      <a href="/api/accounting/export" className="btn" download>
        Download all records
      </a>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={busy}
      onClick={() =>
        start(async () => {
          const r = await exportCsvAction();
          toast(r.message, r.ok ? "ok" : "error");
          if (r.ok && r.csv) {
            const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `checkrail-pay-accounting-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }
          router.refresh();
        })
      }
    >
      {busy ? "Exporting" : `Export CSV (${pendingCount})`}
    </button>
  );
}
