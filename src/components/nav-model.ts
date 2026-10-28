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

