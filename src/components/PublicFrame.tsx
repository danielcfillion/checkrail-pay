import type { ReactNode } from "react";
import { HtmlLang } from "./HtmlLang";

/**
 * The frame of every page a vendor opens from a link: a skip link and the main landmark, both in the page's language.
 * The root layout cannot see a page's search params, so `lang` lives on this frame (screen readers use the nearest
 * lang) and <html lang> is brought into line here: by a one-line script that runs as the page is parsed, so it is right
 * before first paint, and by HtmlLang for client-side navigation. The value is checked to be a bare language tag.
 */
export function PublicFrame({ lang = "en", skip = "Skip to content", children }: { lang?: string; skip?: string; children: ReactNode }) {
  const tag = /^[a-z]{2,3}$/.test(lang) ? lang : "en";
  return (
    <div lang={tag}>
      <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(tag)}` }} />
      <HtmlLang lang={tag} />
      <a href="#main" className="skip-link">
        {skip}
      </a>
      <main id="main" tabIndex={-1} className="print-page mx-auto w-full max-w-xl px-4 py-10 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
