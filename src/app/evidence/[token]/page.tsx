import { getDb } from "@/lib/db";
import { viewEvidenceRequest } from "@/lib/engine/vendorLinks";
import { EvidenceUpload } from "@/components/EvidenceUpload";
import { PublicFrame } from "@/components/PublicFrame";
import { VendorHeader } from "@/components/VendorHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Send a document", robots: { index: false, follow: false } };

export default async function EvidencePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = viewEvidenceRequest(getDb(), token);
  return (
    <PublicFrame>
      <VendorHeader payer={v?.businessName} />
      <h1 className="text-2xl font-semibold tracking-tight">{v ? "We need one document to pay you" : "Link not available"}</h1>
      {!v ? (
        <p className="mt-2 text-ink-soft">This link is not valid or has expired. Ask the business for a new one.</p>
      ) : v.used ? (
        <p className="mt-2 text-ink-soft">A document was already sent with this link. Ask for a new link to send another.</p>
      ) : (
        <>
          <p className="mt-2 text-ink-soft">
            {v.vendorName}, to pay you <span className="num">{v.amount}</span> for <span className="num">{v.reference}</span>, {v.businessName} needs:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {v.needed.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          {v.note ? <p className="mt-2">&ldquo;{v.note}&rdquo;</p> : null}
          <div className="mt-6">
            <EvidenceUpload token={token} />
          </div>
        </>
      )}
    </PublicFrame>
  );
}
