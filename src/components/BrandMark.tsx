/*
 * The Checkrail mark, drawn from the check line: two parallel rails, a short check rail set inside the lower one,
 * and a settled tick at the right end. Same path data as scripts/brand-assets.py (which writes the favicon,
 * the social card and public/brand/*.svg); change both together.
 */

export function BrandMark({ size = 24, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title} focusable="false">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}>
        <path stroke="var(--ink)" d="M3 10H21" />
        <path stroke="var(--ink)" d="M3 22H21" />
        <path stroke="var(--ink)" d="M8 17.5H16" />
        <path stroke="var(--settled)" strokeWidth={3} d="M21.5 16.5l3 3 5-6.5" />
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
