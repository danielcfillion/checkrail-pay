"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { DEMO_GUIDE, groupItems, primaryFor, trimmedNav, type Item } from "./nav-model";
import { RoleSwitch, type Persona } from "./WhoAmI";

/** What the phone More sheet adds at its foot: the demo role switch and the mode list, which live in the sidebar on wider screens. */
export type PhoneExtras = { personas: readonly Persona[] | null; username: string; modes: { summary: string; live: boolean; rows: Array<[string, string, boolean]> } | null };

function useActive() {
  const path = usePathname();
  return { path, isActive: (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/")) };
}

export function NavLinks({ items, mobile = false, demoGuide = false, trimmed = false, phone }: { items: readonly Item[]; mobile?: boolean; demoGuide?: boolean; trimmed?: boolean; phone?: PhoneExtras }) {
  const { path, isActive } = useActive();
  const t = trimmed ? trimmedNav(items) : null;
  const moreHasActive = Boolean(t?.more.some((g) => g.items.some((i) => isActive(i.href))));
  const [moreOpen, setMoreOpen] = useState(moreHasActive);
  // Opening a section that lives under More shows where you are.
  useEffect(() => {
    if (moreHasActive) setMoreOpen(true);
  }, [path, moreHasActive]);
  if (mobile) return <PhoneBar items={items} demoGuide={demoGuide} trimmed={trimmed} extras={phone} />;

  const row = (it: Item) => {
    const active = isActive(it.href);
    return (
      <li key={it.href}>
        <Link
          href={it.href}
          aria-current={active ? "page" : undefined}
          title={it.label}
          className={`flex h-8 items-center gap-2.5 rounded px-2 max-lg:justify-center lg:px-2 ${active ? "bg-sheet font-medium text-ink" : "text-ink-soft hover:text-ink"}`}
          style={active ? { boxShadow: "inset 2px 0 0 var(--ink)" } : undefined}
        >
          <Icon name={it.icon} />
          <span className="hidden lg:inline">{it.label}</span>
        </Link>
      </li>
    );
  };

  if (t) {
    return (
      <div className="space-y-3">
        {demoGuide ? <ul>{row(DEMO_GUIDE)}</ul> : null}
        <ul className="space-y-0.5 max-lg:border-t max-lg:pt-3 hairline" aria-label="Main sections">
          {t.primary.map(row)}
        </ul>
        <details className="nav-more" open={moreOpen} onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="flex h-8 w-full items-center gap-2.5 rounded px-2 text-sm font-normal text-ink-soft hover:text-ink max-lg:justify-center" title="More sections">
            <Icon name="more" />
            <span className="hidden lg:inline">More</span>
          </summary>
          <div className="mt-2 space-y-3">
            {t.more.map((g) => {
              const id = `nav-group-${g.label.toLowerCase()}`;
              return (
                <div key={g.label} className="max-lg:border-t max-lg:pt-3 hairline">
                  <p id={id} className="dense mb-1 hidden px-2 text-[11px] text-ink-soft lg:block">
                    {g.label}
                  </p>
                  <ul className="space-y-0.5" aria-labelledby={id}>
                    {g.items.map(row)}
                  </ul>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {demoGuide ? <ul>{row(DEMO_GUIDE)}</ul> : null}
      {groupItems(items).map((g, gi) => {
        const id = `nav-group-${g.label.toLowerCase()}`;
        return (
          <div key={g.label} className={gi > 0 || demoGuide ? "max-lg:border-t max-lg:pt-3 hairline" : ""}>
            <p id={id} className="dense mb-1 hidden px-2 text-[11px] text-ink-soft lg:block">
              {g.label}
            </p>
            <ul className="space-y-0.5" aria-labelledby={id}>
              {g.items.map(row)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Under 640px: four primary sections and More, which opens a bottom sheet with every other section. */
function PhoneBar({ items, demoGuide, trimmed, extras }: { items: readonly Item[]; demoGuide: boolean; trimmed: boolean; extras?: PhoneExtras }) {
  const { path, isActive } = useActive();
  const [open, setOpen] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const bar = primaryFor(trimmed);
  const primary = bar.map((h) => items.find((i) => i.href === h)).filter((i): i is Item => !!i);
  const restGroups = groupItems(items.filter((i) => !bar.includes(i.href)));
  if (demoGuide) restGroups.unshift({ label: "Demo", items: [DEMO_GUIDE] });
  const moreActive = restGroups.some((g) => g.items.some((i) => isActive(i.href)));

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => moreBtn.current?.focus());
  }, []);

  // Leaving the page closes the sheet.
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      setOpen(false);
    }
  }, [path]);

  const cell = "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 py-1.5 text-2xs";
  return (
    <>
      <ul className="grid grid-cols-5">
        {primary.map((it) => {
          const active = isActive(it.href);
          return (
            <li key={it.href}>
              <Link href={it.href} aria-current={active ? "page" : undefined} className={`${cell} ${active ? "font-medium text-ink" : "text-ink-soft"}`}>
                <Icon name={it.icon} />
                <span>{it.label}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <button
            ref={moreBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls="nav-more-sheet"
            onClick={() => setOpen((o) => !o)}
            className={`${cell} ${moreActive || open ? "font-medium text-ink" : "text-ink-soft"}`}
          >
            <Icon name="more" />
            <span>More</span>
          </button>
        </li>
      </ul>
      {open ? <MoreSheet groups={restGroups} isActive={isActive} onClose={close} extras={extras} /> : null}
    </>
  );
}

function MoreSheet({ groups, isActive, onClose, extras }: { groups: Array<{ label: string; items: Item[] }>; isActive: (href: string) => boolean; onClose: (returnFocus: boolean) => void; extras?: PhoneExtras }) {
  const sheet = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), select:not([disabled]), summary"));
    (focusables().find((f) => f.getAttribute("aria-current") === "page") ?? focusables()[0])?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(true);
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0" style={{ background: "rgb(16 35 58 / 0.4)" }} onClick={() => onClose(false)} aria-hidden />
      <div
        ref={sheet}
        id="nav-more-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-lg border-t bg-sheet hairline"
        style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between border-b px-4 py-1 hairline">
          <h2 id={titleId} className="font-semibold">
            More sections
          </h2>
          <button type="button" onClick={() => onClose(true)} className="-mr-2 flex h-11 min-w-11 items-center justify-center rounded px-2 text-ink-soft hover:text-ink" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.label} className="px-2 pt-2">
            <p className="dense px-2 pb-1 pt-1 text-[11px] text-ink-soft">{g.label}</p>
            <ul>
              {g.items.map((it) => {
                const active = isActive(it.href);
                return (
                  <li key={it.href}>
                    <Link
                      href={it.href}
                      aria-current={active ? "page" : undefined}
                      onClick={() => onClose(false)}
                      className={`flex min-h-11 items-center gap-3 rounded px-2 ${active ? "bg-paper font-medium text-ink" : "text-ink"}`}
                      style={active ? { boxShadow: "inset 2px 0 0 var(--ink)" } : undefined}
                    >
                      <span className="text-ink-soft">
                        <Icon name={it.icon} />
                      </span>
                      <span>{it.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {extras?.personas || extras?.modes ? (
          <div className="mx-4 mt-3 space-y-3 border-t pt-3 hairline">
            {extras.personas ? <RoleSwitch personas={extras.personas} username={extras.username} /> : null}
            {extras.modes ? (
              <div>
                <p className={`dense ${extras.modes.live ? "text-ink" : "text-attention"}`}>{extras.modes.summary}</p>
                <p className="mt-0.5 text-xs text-ink-soft">{extras.modes.live ? "Rail and agent modes" : "Nothing here moves real money."}</p>
                <ul className="dense mt-1.5 space-y-1">
                  {extras.modes.rows.map(([label, mode, sim]) => (
                    <li key={label} className="flex justify-between gap-3">
                      <span className="text-ink-soft">{label}</span>
                      <span className={`truncate text-right ${sim ? "text-ink-soft" : "text-ink"}`}>{mode}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
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
    case "demo":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6.75 5.75v4.5L10.25 8z" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="3.5" cy="8" r="0.75" fill="currentColor" />
          <circle cx="8" cy="8" r="0.75" fill="currentColor" />
          <circle cx="12.5" cy="8" r="0.75" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}
