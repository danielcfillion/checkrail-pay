"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { exportXeroBillsAction } from "@/app/actions";
import { useToast } from "./Toast";

/** Bills agreed since the last export, in Xero's bill import template. */
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
          if (r.ok && r.csv) {
            const url = URL.createObjectURL(new Blob(["﻿" + r.csv], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `xero-bills-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }
          router.refresh();
        })
      }
    >
      {busy ? "Exporting" : count ? `Xero bills to import (${count})` : "No new bills for Xero"}
    </button>
  );
}
