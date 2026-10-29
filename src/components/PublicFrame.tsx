"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The frame of every page a vendor opens from a link: a skip link and the main landmark, both in the page's language.
 * The root layout cannot see the page's search params, so `lang` lives on this frame (screen readers use the nearest
 * lang) and HtmlLang brings <html lang> into line once the page has loaded.
 */
export function PublicFrame({ lang = "en", skip = "Skip to content", children }: { lang?: string; skip?: string; children: ReactNode }) {
  useEffect(() => {
    const el = document.documentElement;
    const before = el.lang;
    el.lang = lang;
    return () => {
      el.lang = before;
    };
  }, [lang]);
  return (
    <div lang={lang}>
      <a href="#main" className="skip-link">
        {skip}
      </a>
      <main id="main" tabIndex={-1} className="print-page mx-auto w-full max-w-xl px-4 py-10 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
