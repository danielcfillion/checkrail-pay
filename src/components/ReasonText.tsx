import Link from "next/link";
import type { ReactNode } from "react";
import type { EarlierPayment } from "@/lib/earlier-payment";
import { formatDate, formatMoney, humaniseStates, stateLabel } from "@/lib/format";
import { tidyDates } from "./decision-model";

/** "paid 16 Sept 2026" for a settled original, otherwise its state in words. */
function standing(e: EarlierPayment): string {
  if (e.state === "settled") return e.settledAt ? `paid ${formatDate(e.settledAt)}` : "paid";
  return stateLabel(e.state).toLowerCase();
}

/**
 * An engine message as people read it: an internal id ("obligation obl_abc (settled)") becomes the
 * original's vendor and reference, linked, and ISO dates become "14 Aug 2026".
 */
export function ReasonText({ text, earlier }: { text: string; earlier?: Map<string, EarlierPayment> }): ReactNode {
  const parts = humaniseStates(tidyDates(text)).split(/((?:payment request|obligation) obl_[a-z0-9]+(?: \([a-z_ ]+\))?|obl_[a-z0-9]+)/i);
  return parts.map((p, i) => {
    const m = p.match(/(obl_[a-z0-9]+)/i);
    if (!m) return <span key={i}>{p}</span>;
    const e = earlier?.get(m[1]);
    if (!e) {
      return (
        <Link key={i} href={`/obligations/${m[1]}`} className="link">
          an earlier request
        </Link>
      );
    }
    return (
      <span key={i}>
        <Link href={`/obligations/${e.id}`} className="link">
          {e.vendorName ?? "the vendor"}, <span className="num">{e.sourceRef ?? "no reference"}</span>
        </Link>
        {` (${[e.amountMinor !== null ? formatMoney(e.amountMinor, e.currency) : null, standing(e)].filter(Boolean).join(", ")})`}
      </span>
    );
  });
}
