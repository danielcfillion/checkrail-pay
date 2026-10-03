import Link from "next/link";
import { listVendors } from "@/lib/queries";
import { countryName, formatDate, roleLabel } from "@/lib/format";
import { EmptyState, Money, PageHeader, RailTag, RelativeTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function VendorsPage() {
  const vendors = listVendors();
  return (
    <>
      <PageHeader title="Vendors" lede="Everyone the business pays, with the payout details on file and what has been paid so far." />
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
                  </td>
                  <td className="text-ink-soft">{roleLabel(v.role)}</td>
                  <td className="hidden text-ink-soft sm:table-cell">{countryName(v.country)}</td>
                  <td className="hidden md:table-cell">
                    <span className="flex flex-wrap gap-1.5">
                      {v.paypalEmail ? <span className="dense rounded-sm bg-paypal-soft px-1.5 py-0.5 text-paypal">PayPal</span> : null}
                      {v.stellarAccount ? <span className="dense rounded-sm bg-stellar-soft px-1.5 py-0.5 text-stellar">Stellar</span> : null}
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
