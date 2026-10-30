import Link from "next/link";
import { TOUCH_INLINE } from "@/components/RequestPanels";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { listDepartures, UNIT_LABEL, type Unit } from "@/lib/engine/rates";
import { EmptyState, PageHeader, Panel } from "@/components/ui";
import { formatDateRange } from "@/lib/format";
import { ImportDepartures } from "@/components/RatesPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Departures" };

export default async function DeparturesPage() {
  const biz = getBusiness();
  if (!biz) return <EmptyState title="No business configured" body="Reset the demo from the overview." />;
  const viewer = await getViewer();
  const deps = listDepartures(getDb(), biz.id);
  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/vendors" className="tap inline-block hover:text-ink">
          Vendors
        </Link>
        <span aria-hidden> / </span>
        Departures
      </nav>
      <PageHeader
        title="Departures"
        lede="Each departure from the booking system, with who serves it and how much. With each vendor's rate card, this is what a job should cost: an invoice above it is stopped, and one that matches can be paid by Autopilot."
        actions={!viewer || viewer.can("verify_vendor") ? <ImportDepartures /> : undefined}
      />
      <Panel title="Manifest format" className="mb-6">
        <pre className="num overflow-auto rounded bg-paper p-3 text-xs leading-5" style={{ fontFamily: "inherit" }}>
          {"code,start,end,guests,vendor,unit,quantity\nHG-4D-1004,2026-10-04,2026-10-07,12,Phuong Transport,vehicle_day,4\nHG-4D-1004,2026-10-04,2026-10-07,12,Linh Family Homestay,guest_night,24"}
        </pre>
        <p className="mt-2 text-xs text-ink-soft">One row per service. Units: {Object.values(UNIT_LABEL).join(", ")}. Importing a departure again replaces its services. Most booking systems (Bokun, Rezdy, a Google Sheet) export this shape. An approver or the owner imports it, because it sets what a job may cost without a person looking.</p>
      </Panel>
      {deps.length ? (
        <div className="panel overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Departure</th>
                <th scope="col">Dates</th>
                <th scope="col" className="r max-sm:hidden">Guests</th>
                <th scope="col">Services</th>
              </tr>
            </thead>
            <tbody>
              {deps.map((d) => (
                <tr key={d.id}>
                  <td className="num font-medium">
                    {d.code}
                    <span className="block text-xs font-normal text-ink-soft sm:hidden">{d.guests} {d.guests === 1 ? "guest" : "guests"}</span>
                  </td>
                  <td className="num text-ink-soft sm:whitespace-nowrap">{formatDateRange(d.startDate, d.endDate)}</td>
                  <td className="r num max-sm:hidden">{d.guests}</td>
                  <td>
                    {d.services.map((s) => (
                      <span key={s.id} className="block">
                        <Link href={`/vendors/${s.vendorId}`} className={`hover:underline ${TOUCH_INLINE}`}>
                          {s.vendorName}
                        </Link>
                        <span className="text-ink-soft">
                          , {s.quantity} {UNIT_LABEL[s.unit as Unit]}
                          {s.quantity === 1 ? "" : "s"}
                        </span>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No departures yet" body="Import the manifest your booking system exports." />
      )}
    </>
  );
}
