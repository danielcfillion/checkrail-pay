import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getVendorDetail } from "@/lib/queries";
import { getViewer } from "@/lib/viewer";
import { PageHeader, Panel } from "@/components/ui";
import { VendorForm, type VendorFormValues } from "@/components/VendorForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit vendor" };

export default async function EditVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  if (viewer && !viewer.can("edit_vendor")) redirect(`/vendors/${id}`);
  const d = getVendorDetail(id);
  if (!d) notFound();
  const v = d.vendor;
  const initial: VendorFormValues = {
    name: v.name,
    role: v.role,
    country: v.country,
    email: v.email ?? "",
    notes: v.notes ?? "",
    defaultAccountCode: v.defaultAccountCode ?? "",
    preferredRail: v.preferredRail ?? "",
    paypalEmail: v.paypalEmail ?? "",
    stellarAccount: v.stellarAccount ?? "",
    bankCountry: v.bankCountry ?? "",
    bankCurrency: v.bankCurrency ?? "",
    bankLabel: v.bankLabel ?? "",
    bankAccountNumber: "",
    bankCode: v.bankCode ?? "",
    accountHolder: v.accountHolder ?? "",
    taxType: v.taxType ?? "",
    taxForm: v.taxForm ?? "",
    withholdingPct: v.withholdingBps ? String(v.withholdingBps / 100) : "",
  };
  return (
    <>
      <nav className="mb-3 text-xs text-ink-soft" aria-label="Breadcrumb">
        <Link href="/vendors" className="hover:text-ink">
          Vendors
        </Link>
        <span aria-hidden> / </span>
        <Link href={`/vendors/${v.id}`} className="hover:text-ink">
          {v.name}
        </Link>
        <span aria-hidden> / </span>
        Edit
      </nav>
      <PageHeader title={`Edit ${v.name}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Profile" aside="saved straight away">
          <VendorForm mode="profile" initial={initial} vendorId={v.id} />
        </Panel>
        <Panel title="Payout details" aside="needs a second person">
          <VendorForm mode="payout" initial={initial} vendorId={v.id} hasAccount={Boolean(v.bankAccountEnc)} />
        </Panel>
      </div>
    </>
  );
}
