/**
 * The page for a sign-in or sign-out post that did not come from this site, including one from a browser or privacy
 * setting that sends Origin "null". A constant: nothing from the request is written into it.
 */
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in again</title><style>:root{color-scheme:light dark;--paper:#edf0f2;--sheet:#fff;--ink:#10233a}@media (prefers-color-scheme:dark){:root{--paper:#0f1923;--sheet:#15222e;--ink:#e6ecf2}}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font:14px/20px system-ui,sans-serif}main{max-width:440px;background:var(--sheet);border-radius:6px;padding:24px}h1{margin:0;font-size:22px;line-height:28px}a{color:inherit}</style></head><body><main><h1>Sign in again</h1><p>This browser did not say the form came from this site, so it was not accepted. Open the <a href="/signin">sign-in page</a> and try again. If it keeps happening, check that a privacy setting is not hiding where requests come from.</p></main></body></html>`;

export function crossOriginPage(): Response {
  return new Response(HTML, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
