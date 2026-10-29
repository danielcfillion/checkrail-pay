/** Navigation structure: sidebar groups and the phone bar. Pure, shared by NavLinks and tests. */

export type Item = { readonly href: string; readonly label: string; readonly icon: string };

/** Sidebar groups, in order. Anything not listed falls into the last group. */
export const NAV_GROUPS: ReadonlyArray<{ label: string; hrefs: readonly string[] }> = [
  { label: "Pay", hrefs: ["/", "/obligations", "/exceptions", "/runs"] },
  { label: "People", hrefs: ["/vendors"] },
  { label: "Books", hrefs: ["/ledger", "/accounting", "/books", "/close"] },
  { label: "Admin", hrefs: ["/audit", "/settings"] },
];

/** The four sections on the phone bar; everything else is one tap away under More. */
export const PHONE_PRIMARY = ["/", "/obligations", "/exceptions", "/close"] as const;

/**
 * The judge's surface. With demo personas on, four sections lead (Overview, Inbox, Daily close, Books) and every
 * other section sits under More, collapsed until opened, on desktop and in the phone bar alike.
 */
export const DEMO_PRIMARY = ["/", "/obligations", "/close", "/books"] as const;

export function primaryFor(trimmed: boolean): readonly string[] {
  return trimmed ? DEMO_PRIMARY : PHONE_PRIMARY;
}

/** Sidebar for the demo: the primary four in order, and the rest in their usual groups under More. */
export function trimmedNav(items: readonly Item[]): { primary: Item[]; more: Array<{ label: string; items: Item[] }> } {
  const primary = DEMO_PRIMARY.map((h) => items.find((i) => i.href === h)).filter((i): i is Item => !!i);
  const more = groupItems(items.filter((i) => !(DEMO_PRIMARY as readonly string[]).includes(i.href)));
  return { primary, more };
}

export const DEMO_GUIDE: Item = { href: "/demo", label: "Demo guide", icon: "demo" };

export function groupItems(items: readonly Item[]): Array<{ label: string; items: Item[] }> {
  const placed = new Set<string>();
  const groups = NAV_GROUPS.map((g) => {
    const its = g.hrefs.map((h) => items.find((i) => i.href === h)).filter((i): i is Item => !!i);
    its.forEach((i) => placed.add(i.href));
    return { label: g.label, items: its };
  });
  const rest = items.filter((i) => !placed.has(i.href));
  if (rest.length) groups[groups.length - 1].items.push(...rest);
  return groups.filter((g) => g.items.length);
}

