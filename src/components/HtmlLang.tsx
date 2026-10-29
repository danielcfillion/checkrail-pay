"use client";

import { useEffect } from "react";

/** Keeps <html lang> in step with a vendor page's language through client-side navigation. */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    const el = document.documentElement;
    const before = el.lang;
    el.lang = lang;
    return () => {
      el.lang = before;
    };
  }, [lang]);
  return null;
}
