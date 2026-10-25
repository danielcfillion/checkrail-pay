import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/viewer";
import { PageHeader, Panel } from "@/components/ui";
import { VendorForm } from "@/components/VendorForm";
import { InviteLink } from "@/components/VendorControls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add vendor" };

export default async function NewVendorPage() {
  const viewer = await getViewer();
  if (viewer && !viewer.can("edit_vendor")) redirect("/vendors");
  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/vendors" className="hover:text-ink">
          Vendors
        </Link>
        <span aria-hidden> / </span>
        Add
      </nav>
      <PageHeader title="Add a vendor" lede="Enter what you know, or send them a link to fill in their own payout details. Either way, someone other than the person who entered the details confirms them with the vendor before the first payment." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Enter the details">
          <VendorForm mode="create" />
        </Panel>
        {!viewer || viewer.can("invite_vendor") ? (
          <Panel title="Or send a link" aside="valid 7 days, single use">
            <p className="mb-3 text-ink-soft">The vendor fills in their own name and payout details. Nothing is paid to them until a person verifies what they sent.</p>
            <InviteLink />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
