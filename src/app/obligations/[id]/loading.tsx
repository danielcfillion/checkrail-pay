/** Shown while a payment request loads: the shape of the page (header, decision band, three columns), with no motion. */
export default function Loading() {
  const block = "rounded-md bg-[color:var(--neutral-soft)]";
  return (
    <div aria-busy="true" aria-label="Loading the payment request">
      <div className={`${block} mb-3 h-4 w-32`} />
      <div className="panel h-40" />
      <div className={`${block} mt-4 h-24`} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_minmax(0,5fr)]">
        <div className="panel h-72" />
        <div className="panel h-72" />
        <div className="panel h-72" />
      </div>
    </div>
  );
}
