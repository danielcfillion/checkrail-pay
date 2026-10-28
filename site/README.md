Host: the brand files are already in `site/brand/`. `scripts/brand-assets.py` copies the mark, the lockup and the social card (`og.png`) here whenever the mark changes. `scripts/screenshots.py` (with the app running) refreshes the product images `product*.png`.
Domain: add checkrailpay.com as a custom domain in that host, then create the CNAME or A records it shows at the domain registrar. The social card URL in `index.html` is `https://checkrailpay.com/brand/og.png`, so link previews work only once the domain serves this folder.

Links: "Try the demo", "Watch the demo" and "View on GitHub" are placeholders. Paste the hosted demo URL (ending in `/demo`), the YouTube URL and the public repository URL into their `href`. Any button whose `href` is still `#` is hidden, so a dead link never shows. While none is filled in, the page shows "Read how it works" instead.

Check before publishing: `node scripts/check-site.mjs` fails if a visible `href="#"` link would show, or if `og:image` is not an absolute https URL.

Publish this folder as a Render static site (publish directory `site`, no build command) or with GitHub Pages.
