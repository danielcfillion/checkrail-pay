"use client";

import { useState, useTransition } from "react";
import { runRemittancesAction } from "@/app/actions";
import { CopyButton } from "./CopyButton";
import { useToast } from "./Toast";

/** After a run: the remittance message for each vendor, in their language, ready to paste into Zalo, WhatsApp or email. */
export function RunRemittances({ runId }: { runId: string }) {
  const [items, setItems] = useState<Array<{ vendorName: string; text: string }> | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  if (items)
    return (
      <ul className="space-y-3 text-sm">
        {items.map((i, n) => (
          <li key={n}>
            <p className="font-medium">{i.vendorName}</p>
            <p className="break-all rounded bg-paper p-2 text-xs">{i.text}</p>
            <CopyButton value={i.text} label={`Copy message for ${i.vendorName}`} />
          </li>
        ))}
        <li className="text-xs text-ink-soft">Shown once. Each link opens that vendor&apos;s own advice, nothing else.</li>
      </ul>
    );
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runRemittancesAction(runId);
          if (!r.ok || !r.items) return toast(r.message, "error");
          setItems(r.items.map((i) => ({ vendorName: i.vendorName, text: i.text.replace("{link}", `${window.location.origin}${i.path}`) })));
        })
      }
    >
      {pending ? "Making messages" : "Remittance messages for every vendor"}
    </button>
  );
}
