import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

/**
 * Header for the pages a vendor opens from a link (onboarding, evidence, remittance): who is paying them, large,
 * and a small Checkrail mark so they know which system sent the link.
 */
export function VendorHeader({ payer, aside }: { payer: string | null | undefined; aside?: ReactNode }) {
  return (
    <header className="mb-6 flex items-center justify-between gap-4 border-b pb-4 hairline">
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold leading-6">{payer || "Checkrail Pay"}</p>
        <p className="dense mt-0.5 flex items-center gap-1.5 text-ink-soft">
          <BrandMark size={16} />
          <span>Sent with Checkrail Pay</span>
        </p>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}
