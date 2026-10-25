import { formatDate } from "@/lib/format";
import { getDb } from "@/lib/db";
import { lookupInvite } from "@/lib/engine/vendors";
import { VendorForm } from "@/components/VendorForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your payment details", robots: { index: false, follow: false } };

/** What a vendor sees from their onboarding link. No navigation, no business data beyond the business name. */
export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const view = lookupInvite(db, token);
  const biz = view.ok ? await db.query.businesses.findFirst({ where: (b, { eq }) => eq(b.id, view.businessId) }) : null;
  return (
    <>
      <p className="dense text-ink-soft">Checkrail Pay</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{view.ok ? `Payment details for ${biz?.name ?? "your client"}` : "Link not available"}</h1>
      {view.ok ? (
        <>
          <p className="mt-2 text-ink-soft">
            {view.vendorName ? `${view.vendorName}, tell us where you want to be paid.` : "Tell us who you are and where you want to be paid."} The business will confirm these details with you before sending any money. This link works once and expires on {formatDate(view.expiresAt)}.
          </p>
          <div className="mt-6">
            <VendorForm mode={view.vendorName ? "onboard-existing" : "onboard-new"} token={token} />
          </div>
        </>
      ) : (
        <p className="mt-2 text-ink-soft">{view.reason}</p>
      )}
    </>
  );
}
