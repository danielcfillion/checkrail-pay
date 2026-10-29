/**
 * The body of the 401 a browser gets before it has a login. A judge who cancels the browser's password prompt, or opens
 * the link in a preview that cannot show one, lands on this instead of a bare line of text. It is a constant: nothing
 * from the request (path, query, headers) is ever written into it. The status and the WWW-Authenticate header are
 * the middleware's, unchanged.
 */
export const AUTH_REQUIRED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Checkrail Pay, sign in</title>
<style>
:root{color-scheme:light dark;--paper:#edf0f2;--sheet:#fff;--ink:#10233a;--soft:#5b6b7c;--rule:rgba(91,107,124,.24)}
@media (prefers-color-scheme:dark){:root{--paper:#0f1923;--sheet:#15222e;--ink:#e6ecf2;--soft:#93a3b4;--rule:rgba(147,163,180,.24)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--paper);color:var(--ink);font:14px/20px system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:24px}
h1{margin:0;font-size:22px;line-height:28px;font-weight:600}
p{margin:8px 0 0}
.soft{color:var(--soft)}
</style>
</head>
<body>
<main>
<h1>Checkrail Pay</h1>
<p>Checks every supplier payment before money moves.</p>
<p class="soft">Sign in to continue. Your browser asks for a username and password; reload this page to be asked again. For the hosted demo, the login is in the Devpost testing instructions.</p>
</main>
</body>
</html>
`;
