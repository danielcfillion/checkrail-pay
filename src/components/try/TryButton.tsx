import Link from "next/link";

/** Opens Try it yourself. Shown beside Take the tour where the visitor has their own sandbox copy on simulated rails. */
export function TryButton({ size = "md", primary = false }: { size?: "sm" | "md"; primary?: boolean }) {
  return (
    <Link href="/try" className={`btn ${primary ? "btn-primary" : ""} ${size === "sm" ? "btn-sm" : ""}`}>
      Try it yourself
    </Link>
  );
}
