"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { readonly href: string; readonly label: string; readonly icon: string };

export function NavLinks({ items, mobile = false }: { items: readonly Item[]; mobile?: boolean }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

  if (mobile) {
    const shown = items.filter((i) => ["/", "/obligations", "/close", "/exceptions", "/settings"].includes(i.href));
    return (
      <ul className="grid grid-cols-5">
        {shown.map((it) => {
          const active = isActive(it.href);
          return (
            <li key={it.href}>
              <Link href={it.href} aria-current={active ? "page" : undefined} className={`flex flex-col items-center gap-0.5 py-2 text-2xs ${active ? "text-ink" : "text-ink-soft"}`}>
                <Icon name={it.icon} />
                <span>{it.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const active = isActive(it.href);
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              title={it.label}
              className={`flex h-8 items-center gap-2.5 rounded px-2 lg:px-2 ${active ? "bg-sheet font-medium text-ink" : "text-ink-soft hover:text-ink"}`}
              style={active ? { boxShadow: "inset 2px 0 0 var(--ink)" } : undefined}
            >
              <Icon name={it.icon} />
              <span className="hidden lg:inline">{it.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** 16px, stroke 1.5, inline. The only icons in the app. */
function Icon({ name }: { name: string }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "shrink-0" };
  switch (name) {
    case "overview":
      return (
        <svg {...common}>
          <path d="M2 8h3l2-4 2 8 2-4h3" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...common}>
          <path d="M2.5 9.5h3l1 2h3l1-2h3" />
          <path d="M3.5 3.5h9l1 6v3h-11v-3z" />
        </svg>
      );
    case "vendors":
      return (
        <svg {...common}>
          <circle cx="6" cy="5.5" r="2.25" />
          <path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
          <path d="M10.5 3.5a2.25 2.25 0 0 1 0 4" />
          <path d="M12 9.3c1.2.6 2 1.9 2 3.7" />
        </svg>
      );
    case "runs":
      return (
        <svg {...common}>
          <path d="M2.5 4.5h7M2.5 8h7M2.5 11.5h4.5" />
          <path d="M11 9.5l2.5 2-2.5 2" />
          <path d="M9.5 11.5h4" />
        </svg>
      );
    case "ledger":
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
          <path d="M5 6h6M5 8.5h6M5 11h3.5" />
        </svg>
      );
    case "exceptions":
      return (
        <svg {...common}>
          <path d="M8 2.5l6 11H2z" />
          <path d="M8 7v3M8 11.8v.2" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="11" height="10" rx="1" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
          <path d="M5.8 10l1.6 1.6 3-3.2" />
        </svg>
      );
    case "accounting":
      return (
        <svg {...common}>
          <path d="M3 13h10" />
          <path d="M4 13V7M8 13V4M12 13V9" />
        </svg>
      );
    case "books":
      return (
        <svg {...common}>
          <path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3z" />
          <path d="M13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z" />
        </svg>
      );
    case "audit":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.3l2.2 1.3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M3 5h10M3 11h10" />
          <circle cx="6" cy="5" r="1.5" fill="var(--sheet)" />
          <circle cx="10" cy="11" r="1.5" fill="var(--sheet)" />
        </svg>
      );
    default:
      return null;
  }
}
