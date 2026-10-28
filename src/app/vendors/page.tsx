import { runAs } from "@/lib/engine/requestContext";
import Link from "next/link";
import { listVendors } from "@/lib/queries";
import { countryName, formatDate, roleLabel } from "@/lib/format";
import { EmptyState, Money, PageHeader, Panel, RailTag, RelativeTime } from "@/components/ui";
import { getDb } from "@/lib/db";
import { getBusiness } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { describeChange, pendingChanges, verifyBarrier } from "@/lib/engine/vendors";
import { PendingChange } from "@/components/VendorControls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendors" };

export default async function VendorsPage() {
  const vendors = listVendors();
  const viewer = await getViewer();
  const biz = getBusiness();
  const db = getDb();
  const pending = biz ? pendingChanges(db, biz.id) : [];
  return (
    <>
      <PageHeader
        title="Vendors"
        lede="Everyone the business pays, with the payout details on file and what has been paid so far. New details wait for a second person before any money goes there."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/departures" className="btn">
              Departures and rates
            </Link>
            {!viewer || viewer.can("edit_vendor") ? (
              <Link href="/vendors/new" className="btn btn-primary">
                Add vendor
              </Link>
            ) : null}
          </div>
        }
      />
      {pending.length && biz ? (
        <Panel title="Waiting for verification" aside={`${pending.length} request${pending.length === 1 ? "" : "s"}`} className="mb-6">
          <div className="space-y-6">
            {pending.map((c) => (
              <div key={c.id} className="border-b pb-5 last:border-0 last:pb-0 hairline">
                <PendingChange c={describeChange(db, c)} canVerify={!viewer || viewer.can("verify_vendor")} mine={viewer ? runAs(viewer.login, () => verifyBarrier(db, biz.id, viewer.actor.id, c)) : null} />
                {c.vendorId ? (
                  <Link href={`/vendors/${c.vendorId}`} className="link mt-2 inline-block text-xs">
                    Open vendor
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      {vendors.length === 0 ? (
        <EmptyState title="No vendors yet" body="Vendors are created with the demo seed. Reset the demo from the overview to load the Ridgeline roster." />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Role</th>
                <th scope="col" className="hidden sm:table-cell">
                  Country
                </th>
                <th scope="col" className="hidden md:table-cell">
                  Payout methods on file
                </th>
                <th scope="col" className="hidden lg:table-cell">
                  Verified
                </th>
                <th scope="col" className="r">
                  Paid total
                </th>
                <th scope="col" className="hidden sm:table-cell">
                  Last paid
                </th>
                <th scope="col" className="hidden md:table-cell">
                  Rails used
                </th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} className="row-link relative">
                  <td className="font-medium">
                    <Link href={`/vendors/${v.id}`} className="after:absolute after:inset-0 after:content-['']">
                      {v.name}
                    </Link>
                    {v.openCount ? <span className="num ml-2 text-xs text-ink-soft">{v.openCount} open</span> : null}
                    {v.status === "blocked" ? <span className="ml-2 text-xs font-medium text-attention">blocked</span> : null}
                  </td>
                  <td className="text-ink-soft">{roleLabel(v.role)}</td>
                  <td className="hidden text-ink-soft sm:table-cell">{countryName(v.country)}</td>
                  <td className="hidden md:table-cell">
                    <span className="flex flex-wrap gap-1.5">
                      {v.paypalEmail ? <span className="dense rounded-sm bg-paypal-soft px-1.5 py-0.5 text-paypal-text">PayPal</span> : null}
                      {v.stellarAccount ? <span className="dense rounded-sm bg-stellar-soft px-1.5 py-0.5 text-stellar-text">Stellar</span> : null}
                      {v.bankLabel ? <span className="dense rounded-sm bg-paper px-1.5 py-0.5 text-ink-soft">{v.bankLabel}</span> : null}
                    </span>
                  </td>
                  <td className="num hidden text-ink-soft lg:table-cell">{v.verifiedAt ? formatDate(v.verifiedAt) : "not verified"}</td>
                  <td className="r">
                    <Money minor={v.paidMinor} currency="USD" />
                  </td>
                  <td className="hidden text-ink-soft sm:table-cell">
                    <RelativeTime iso={v.lastPaidAt} />
                  </td>
                  <td className="hidden md:table-cell">
                    <span className="flex gap-1">{v.railsUsed.length ? v.railsUsed.map((r) => <RailTag key={r} rail={r} />) : <span className="text-ink-soft">none yet</span>}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
