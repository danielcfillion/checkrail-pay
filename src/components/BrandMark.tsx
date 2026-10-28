/*
 * The Checkrail mark: a short length of track seen from above. Four ties in soft ink, two ink rails, a short
 * check rail laid inside the lower rail, and a settled tick where the track ends. The ties keep it from reading as
 * a "checklist done" icon at 16px. Same path data as scripts/brand-assets.py (which writes the favicon, the social
 * card, public/brand/*.svg and site/brand/); change both together.
 */

const TIES = ["M4.5 7V25", "M9.5 7V25", "M14.5 7V25", "M19.5 7V25"];
const RAILS = ["M2 10.5H21.5", "M2 21.5H21.5"];
const CHECK_RAIL = "M7 17.5H17";
const TICK = "M22.5 17l2.5 3 5-6.5";

export function BrandMark({ size = 24, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title} focusable="false">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {TIES.map((d) => (
          <path key={d} stroke="var(--ink-soft)" strokeWidth={2} d={d} />
        ))}
        {RAILS.map((d) => (
          <path key={d} stroke="var(--ink)" strokeWidth={2.75} d={d} />
        ))}
        <path stroke="var(--ink)" strokeWidth={2.25} d={CHECK_RAIL} />
        <path stroke="var(--settled)" strokeWidth={3} d={TICK} />
      </g>
    </svg>
  );
}

/** Mark plus wordmark (Archivo width 112, weight 600). */
export function BrandLockup({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <BrandMark size={Math.round(size * 1.45)} />
      <span className="wide whitespace-nowrap" style={{ fontSize: size, lineHeight: 1 }}>
        Checkrail Pay
      </span>
    </span>
  );
}
