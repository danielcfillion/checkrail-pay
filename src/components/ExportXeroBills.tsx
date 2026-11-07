"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { exportXeroBillsAction } from "@/app/actions";
import { useToast } from "./Toast";

/**
 * Bills agreed since the last export, in Xero's bill import template. Each export is recorded and the file is
 * downloaded from that record, so the first download and any "Download again" are the same bytes.
 */
export function ExportXeroBills({ count }: { count: number }) {
  const [busy, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="btn"
      disabled={busy || count === 0}
      onClick={() =>
        start(async () => {
          const r = await exportXeroBillsAction();
          toast(r.message, r.ok ? "ok" : "error");
          if (r.ok && r.exportId) {
            const a = document.createElement("a");
            a.href = `/api/accounting/bill-exports/${encodeURIComponent(r.exportId)}`;
            a.download = "";
            a.click();
          }
          router.refresh();
        })
      }
    >
      {busy ? "Exporting" : count ? `Export new bills for Xero (${count})` : "No new bills for Xero"}
    </button>
  );
}
