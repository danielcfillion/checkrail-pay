import { getDb } from "@/lib/db";
import { viewRemittance } from "@/lib/engine/vendorLinks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Remittance advice", robots: { index: false, follow: false } };

const T = {
  en: { title: "Remittance advice", from: "From", to: "To", ref: "For", amount: "Amount", received: "You receive", via: "Paid by", date: "Date", pref: "Provider reference", paid: "Paid", way: "On its way" },
  vi: { title: "Thông báo thanh toán", from: "Bên trả", to: "Bên nhận", ref: "Cho", amount: "Số tiền", received: "Bạn nhận", via: "Hình thức", date: "Ngày", pref: "Mã giao dịch", paid: "Đã thanh toán", way: "Đang chuyển" },
};

export default async function RemitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = viewRemittance(getDb(), token);
  if (!r) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Link not available</h1>
        <p className="mt-2 text-ink-soft">This link is not valid or has expired.</p>
      </>
    );
  }
  const t = T[r.language];
  const rows: Array<[string, string | null]> = [
    [t.from, r.businessName],
    [t.to, r.vendorName],
    [t.ref, r.reference],
    [t.amount, r.amount],
    [t.received, r.received],
    [t.via, r.rail],
    [t.date, r.date],
    [t.pref, r.providerRef],
  ];
  return (
    <article className="panel p-6">
      <p className="dense text-ink-soft">Checkrail Pay</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t.title}</h1>
      <p className={`mt-1 font-medium ${r.status === "paid" ? "text-settled" : "text-attention"}`}>{r.status === "paid" ? t.paid : t.way}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-soft">{k}</dt>
              <dd className="num break-all">{v}</dd>
            </div>
          ))}
      </dl>
    </article>
  );
}
