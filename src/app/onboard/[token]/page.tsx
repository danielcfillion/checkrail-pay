import { formatDate } from "@/lib/format";
import { getDb } from "@/lib/db";
import { lookupInvite } from "@/lib/engine/vendors";
import { formatExpiryVi, linkReasonCode, resolveLang, STRINGS } from "@/lib/onboarding-strings";
import { PublicFrame } from "@/components/PublicFrame";
import { VendorForm } from "@/components/VendorForm";
import { VendorHeader } from "@/components/VendorHeader";

export const dynamic = "force-dynamic";

/** The tab title in the vendor's language, from the same choice the page makes. */
export async function generateMetadata({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang: asked } = await searchParams;
  const view = lookupInvite(getDb(), token);
  const lang = resolveLang(asked, view.ok ? view.vendorCountry : null);
  return { title: STRINGS[lang].pageTitle, robots: { index: false, follow: false } };
}

/** What a vendor sees from their onboarding link. No navigation, no business data beyond the business name. */
export default async function OnboardPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang: asked } = await searchParams;
  const db = getDb();
  const view = lookupInvite(db, token);
  const biz = view.ok ? await db.query.businesses.findFirst({ where: (b, { eq }) => eq(b.id, view.businessId) }) : null;
  // Vietnamese when the vendor is Vietnamese or asks for it; one link switches.
  const lang = resolveLang(asked, view.ok ? view.vendorCountry : null);
  const t = STRINGS[lang];
  const business = biz?.name ?? "";
  return (
    <PublicFrame lang={lang} skip={t.skip}>
      <VendorHeader
        payer={biz?.name}
        sentWith={t.sentWith}
        aside={
          <a className="link text-sm" href={`?lang=${lang === "vi" ? "en" : "vi"}`} lang={lang === "vi" ? "en" : "vi"}>
            {t.switchTo}
          </a>
        }
      />
      {view.ok ? (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{t.heading(business)}</h1>
          <div className="mt-2">
            <VendorForm
              mode={view.vendorName ? "onboard-existing" : "onboard-new"}
              token={token}
              lang={lang}
              defaultCountry={view.vendorCountry ?? "VN"}
              business={business}
              intro={
                <div className="mb-6 space-y-2 text-ink-soft">
                  <p>{view.vendorName ? t.known(view.vendorName) : t.unknown}</p>
                  <p>{t.trust(business)}</p>
                  <p>
                    {t.confirm} {t.once(lang === "vi" ? formatExpiryVi(view.expiresAt) : formatDate(view.expiresAt))}
                  </p>
                </div>
              }
            />
          </div>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{t.linkUnavailable}</h1>
          <p className="mt-2 text-ink-soft">{t.errors[linkReasonCode(view.reason)]}</p>
        </>
      )}
    </PublicFrame>
  );
}
