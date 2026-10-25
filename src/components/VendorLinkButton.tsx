"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVendorLinkAction } from "@/app/actions";
import { CopyButton } from "./CopyButton";
import { useToast } from "./Toast";

/** Make a remittance or evidence link for this payment, and the message to paste into Zalo, WhatsApp or email. */
export function VendorLinkButton({ kind, obligationId }: { kind: "remittance" | "evidence"; obligationId: string }) {
  const [out, setOut] = useState<{ url: string; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const make = () =>
    start(async () => {
      const r = await createVendorLinkAction(kind, obligationId, note || undefined);
      if (!r.ok || !r.path) return toast(r.message, "error");
      const url = `${window.location.origin}${r.path}`;
      setOut({ url, text: r.text ? r.text.replace("{link}", url) : `Please send the document for this payment here: ${url}` });
      router.refresh();
    });
  if (out)
    return (
      <div className="space-y-2 text-sm">
        <p className="break-all rounded bg-paper p-2 text-xs">{out.text}</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={out.text} label="Copy message" />
          <CopyButton value={out.url} label="Copy link only" />
        </div>
        <p className="text-xs text-ink-soft">Shown once. Send it over a channel you already use with this vendor.</p>
      </div>
    );
  if (kind === "evidence" && asking)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="What you need" className="field" style={{ width: "16rem" }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="The signed trip sheet for HG-4D-1004" />
        <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={make}>
          {pending ? "Making link" : "Make the link"}
        </button>
      </div>
    );
  return (
    <button type="button" className="btn btn-sm" disabled={pending} onClick={() => (kind === "evidence" ? setAsking(true) : make())}>
      {kind === "remittance" ? "Remittance advice for the vendor" : "Ask the vendor for the document"}
    </button>
  );
}
