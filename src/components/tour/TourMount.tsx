import { cookies } from "next/headers";
import { findObligationsBySourceRef } from "@/lib/queries";
import { sandboxActive } from "@/lib/sandbox/server";
import { tourEnabled } from "./enabled";
import { TOUR_COOKIE, parseTourCookie, type TourIds } from "./steps";
import { Tour } from "./Tour";

/** Mounted once from the layout. Renders nothing unless the tour is offered here (the demo). */
export async function TourMount() {
  if (!tourEnabled()) return null;
  const initial = parseTourCookie((await cookies()).get(TOUR_COOKIE)?.value);
  let ids: TourIds = {};
  try {
    const rows = findObligationsBySourceRef(["INV-2026-0152", "JOB-HG4D-0914", "JOB-HG4D-0921"]);
    ids = {
      phuong: rows.find((r) => r.sourceRef === "INV-2026-0152" && r.vendorId === "ven_phuong")?.id ?? null,
      // The duplicate shares its reference with the settled original: the open one is the story.
      duplicate: rows.find((r) => r.sourceRef === "JOB-HG4D-0914" && r.state !== "settled")?.id ?? null,
      paypal: rows.find((r) => r.sourceRef === "JOB-HG4D-0921")?.id ?? null,
    };
  } catch {
    // No database or no business: the steps that need a request say so.
  }
  return <Tour initial={initial} ids={ids} sandbox={sandboxActive()} />;
}
