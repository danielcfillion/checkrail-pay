import { formatDate } from "@/lib/format";
import { getDb } from "@/lib/db";
import { lookupInvite } from "@/lib/engine/vendors";
import { VendorForm } from "@/components/VendorForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your payment details", robots: { index: false, follow: false } };

const T = {
  en: { title: (b: string) => `Payment details for ${b}`, known: (n: string) => `${n}, tell us where you want to be paid.`, unknown: "Tell us who you are and where you want to be paid.", confirm: "The business will confirm these details with you before sending any money.", once: (d: string) => `This link works once and expires on ${d}.`, other: "Tiếng Việt" },
  vi: { title: (b: string) => `Thông tin nhận tiền cho ${b}`, known: (n: string) => `${n}, vui lòng cho biết bạn muốn nhận tiền ở đâu.`, unknown: "Vui lòng cho biết bạn là ai và muốn nhận tiền ở đâu.", confirm: "Doanh nghiệp sẽ xác nhận lại với bạn trước khi chuyển tiền.", once: (d: string) => `Đường dẫn này chỉ dùng một lần và hết hạn ngày ${d}.`, other: "English" },
};

/** What a vendor sees from their onboarding link. No navigation, no business data beyond the business name. */
export default async function OnboardPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang: asked } = await searchParams;
  const db = getDb();
  const view = lookupInvite(db, token);
  const biz = view.ok ? await db.query.businesses.findFirst({ where: (b, { eq }) => eq(b.id, view.businessId) }) : null;
  // Vietnamese when the vendor is Vietnamese or asks for it; one link switches.
  const lang: "en" | "vi" = asked === "vi" || asked === "en" ? asked : view.ok && view.vendorCountry === "VN" ? "vi" : "en";
  const t = T[lang];
  return (
    <>
      <p className="dense flex justify-between text-ink-soft">
        <span>Checkrail Pay</span>
        <a className="link" href={`?lang=${lang === "vi" ? "en" : "vi"}`}>
          {t.other}
        </a>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{view.ok ? t.title(biz?.name ?? "") : "Link not available"}</h1>
      {view.ok ? (
        <>
          <p className="mt-2 text-ink-soft">
            {view.vendorName ? t.known(view.vendorName) : t.unknown} {t.confirm} {t.once(lang === "vi" ? new Date(view.expiresAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : formatDate(view.expiresAt))}
          </p>
          <div className="mt-6">
            <VendorForm mode={view.vendorName ? "onboard-existing" : "onboard-new"} token={token} lang={lang} defaultCountry={view.vendorCountry ?? "VN"} />
          </div>
        </>
      ) : (
        <p className="mt-2 text-ink-soft">{view.reason}</p>
      )}
    </>
  );
}
