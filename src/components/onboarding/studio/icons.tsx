/* Small status glyphs drawn in currentColor; the class sets the status colour. */

export function CheckIcon({ className = "", small = false }: { className?: string; small?: boolean }) {
  const s = small ? 14 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Met" role="img" className={`cr-icon ${className}`}>
      <path d="M3.5 8.5l3 3 6-6.5" />
    </svg>
  );
}

export function WaitIcon({ className = "", small = false }: { className?: string; small?: boolean }) {
  const s = small ? 14 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-label="Not met yet" role="img" className={`cr-icon ${className}`}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.5" />
    </svg>
  );
}
