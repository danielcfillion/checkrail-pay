"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTaxSettingsAction } from "@/app/actions";
import { useToast } from "./Toast";

export function TaxSettings({ vnPit, phEwt, editable }: { vnPit: boolean; phEwt: boolean; editable: boolean }) {
  const [a, setA] = useState(vnPit);
  const [b, setB] = useState(phEwt);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2 py-1">
        <input type="checkbox" checked={a} disabled={!editable} onChange={(e) => setA(e.target.checked)} className="mt-1" />
        <span>We pay as a Vietnamese entity: withhold 10% personal income tax from individuals paid VND 2,000,000 or more (unless they gave form 08/CK-TNCN).</span>
      </label>
      <label className="flex cursor-pointer items-start gap-2 py-1">
        <input type="checkbox" checked={b} disabled={!editable} onChange={(e) => setB(e.target.checked)} className="mt-1" />
        <span>We pay as a Philippine entity: withhold expanded withholding tax at each payee&apos;s rate (set on the vendor).</span>
      </label>
      {editable ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending || (a === vnPit && b === phEwt)}
          onClick={() =>
            start(async () => {
              const r = await setTaxSettingsAction({ withholdVnPit: a, withholdPhEwt: b });
              toast(r.message, r.ok ? "ok" : "error");
              router.refresh();
            })
          }
        >
          {pending ? "Saving" : "Save tax settings"}
        </button>
      ) : null}
    </div>
  );
}
