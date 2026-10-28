import { getDb } from "@/lib/db";
import { viewRemittance } from "@/lib/engine/vendorLinks";
import { VendorHeader } from "@/components/VendorHeader";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Remittance advice", robots: { index: false, follow: false } };

const T = {
  en: { title: "Remittance advice", from: "From", to: "To", ref: "For", amount: "Amount", received: "You receive", via: "Paid by", date: "Date", pref: "Provider reference", paid: "Paid", way: "On its way", withheld: "Tax withheld (paid to the tax office)", invoice: "Invoice", total: "Total", left: "Left to pay", short: "Your invoice says", agreed: "we paid the agreed rate", kinds: { deposit: "Deposit", balance: "Balance", part: "Part payment", payment: "Payment", credit: "Credit note", advance: "Advance" }, now: "this payment", save: "Save as PDF", issued: "Issued by" },
  vi: { title: "Thông báo thanh toán", from: "Bên trả", to: "Bên nhận", ref: "Cho", amount: "Số tiền", received: "Bạn nhận", via: "Hình thức", date: "Ngày", pref: "Mã giao dịch", paid: "Đã thanh toán", way: "Đang chuyển", withheld: "Thuế khấu trừ (nộp cho cơ quan thuế)", invoice: "Hóa đơn", total: "Tổng", left: "Còn lại", short: "Hóa đơn ghi", agreed: "chúng tôi thanh toán theo giá đã thỏa thuận", kinds: { deposit: "Đặt cọc", balance: "Thanh toán còn lại", part: "Thanh toán một phần", payment: "Thanh toán", credit: "Giảm trừ", advance: "Tạm ứng" }, now: "lần này", save: "Lưu PDF", issued: "Phát hành bởi" },
};

export default async function RemitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = viewRemittance(getDb(), token);
  if (!r) {
    return (
      <>
        <VendorHeader payer={null} />
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
    [t.withheld, r.withheld],
    [t.via, r.rail],
    [t.date, r.date],
    [t.pref, r.providerRef],
  ];
  return (
    <>
      <VendorHeader payer={r.businessName} aside={<PrintButton label={t.save} />} />
      <article className="print-sheet panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
          <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium ${r.status === "paid" ? "bg-settled-soft text-settled" : "bg-attention-soft text-attention"}`}>{r.status === "paid" ? t.paid : t.way}</span>
        </div>
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
        {r.shortPaid ? (
          <p className="mt-4 rounded bg-attention-soft px-3 py-2 text-sm">
            {t.short} {r.shortPaid.invoiced}; {t.agreed} ({r.shortPaid.basis}).
          </p>
        ) : null}
        {r.history ? (
          <section className="mt-5 border-t pt-4 hairline">
            <h2 className="font-medium">
              {t.invoice} {r.reference}: {t.total} {r.history.total}
            </h2>
            <ul className="mt-2 space-y-1 text-sm">
              {r.history.lines.map((l, i) => (
                <li key={i} className={`num flex justify-between gap-4 ${l.thisOne ? "font-medium" : "text-ink-soft"}`}>
                  <span>
                    {t.kinds[l.label]} {l.label === "credit" ? l.reference : ""} {l.date}
                    {l.thisOne ? ` (${t.now})` : ""}
                  </span>
                  <span>{l.label === "credit" ? `-${l.amount}` : l.amount}</span>
                </li>
              ))}
            </ul>
            <p className="num mt-2 flex justify-between border-t pt-2 font-medium hairline">
              <span>{t.left}</span>
              <span>{r.history.left}</span>
            </p>
          </section>
        ) : null}
        <p className="dense mt-6 border-t pt-3 text-ink-soft hairline">
          {t.issued} {r.businessName}, {r.date}.
        </p>
      </article>
    </>
  );
}
