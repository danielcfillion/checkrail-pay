import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { POST as signInPost } from "@/app/api/signin/route";
import { POST as signOutPost } from "@/app/api/signout/route";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER, configuredUsers } from "../basicAuth";
import { SANDBOX_COOKIE } from "../sandbox/settings";
import { FAIL_LIMIT, SESSION_COOKIE, SESSION_MAX_AGE, safeNext, sessionKey, signInUrl, signSession, verifySession } from "./session";

const KEYS = ["CHECKRAIL_USERS", "CHECKRAIL_BASIC_AUTH", "DUELINE_BASIC_AUTH", "CHECKRAIL_SESSION_SECRET", "CHECKRAIL_SANDBOX_SECRET", "CHECKRAIL_DATA_KEY", "CHECKRAIL_SANDBOX", "CHECKRAIL_DEMO_PERSONAS", "CHECKRAIL_THROTTLE_SPARES_VALID", "CHECKRAIL_LOG_CLIENT_IP", "PAYPAL_ENV", "RAIL_MODE", "AI_MODE"] as const;
const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k];
  for (const k of KEYS) delete env[k];
  env.CHECKRAIL_USERS = "judge:a-long-enough-pass:admin";
  env.CHECKRAIL_SESSION_SECRET = "a-session-secret-for-tests";
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  env.NODE_ENV = "test";
  vi.restoreAllMocks();
});

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const page = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers: { accept: HTML, ...headers } });
const fwd = (res: Response, h: string) => res.headers.get(`x-middleware-request-${h}`);
const cookieFor = (user = "judge", pass = "a-long-enough-pass", role = "admin" as const, now = Date.now()) => signSession({ user, pass, role }, sessionKey(env)!, now);

function form(fields: Record<string, string>, headers: Record<string, string> = {}, url = "http://localhost/api/signin") {
  return new NextRequest(url, { method: "POST", body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost", ...headers } });
}

describe("middleware without a login", () => {
  it("sends a page request to /signin with the page it asked for, and no challenge, so no pop-up appears", () => {
    const res = middleware(page("/obligations?filter=mine"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/signin?next=%2Fobligations%3Ffilter%3Dmine");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("answers fetch, RSC, prefetch and server-action requests with 401 JSON, never a redirect", async () => {
    const cases: Array<[string, Record<string, string>, string?]> = [
      ["/obligations", { accept: "*/*" }],
      ["/obligations", { accept: HTML, rsc: "1" }],
      ["/obligations", { accept: HTML, "next-router-prefetch": "1" }],
      ["/api/attachments/x", { accept: "application/json" }],
    ];
    for (const [path, headers] of cases) {
      const res = middleware(new NextRequest(`http://localhost${path}`, { headers }));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toEqual({ error: "Sign in required.", signIn: "/signin" });
    }
    const action = middleware(new NextRequest("http://localhost/obligations", { method: "POST", headers: { accept: "text/x-component", "next-action": "abc" } }));
    expect(action.status).toBe(401);
  });

  it("lets the sign-in page through bare, with no sandbox copy started", () => {
    env.CHECKRAIL_SANDBOX = "1";
    env.CHECKRAIL_SANDBOX_SECRET = "a-sandbox-secret-for-tests";
    for (const p of ["/signin", "/api/signin", "/api/signout"]) {
      const res = middleware(page(p));
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(fwd(res, "x-checkrail-sandbox")).toBeNull();
    }
    expect(fwd(middleware(page("/signin")), "x-checkrail-public")).toBe("1");
    // A signed-in page in sandbox mode still gets its copy, exactly once.
    const signedIn = middleware(page("/", { cookie: `${SESSION_COOKIE}=${cookieFor()}` }));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain(`${SANDBOX_COOKIE}=`);
  });
});

describe("middleware with a session cookie", () => {
  it("accepts a valid cookie and takes the role from CHECKRAIL_USERS", () => {
    env.CHECKRAIL_USERS = "judge:a-long-enough-pass:admin,lan:another-pass-2:clerk";
    const res = middleware(page("/", { cookie: `${SESSION_COOKIE}=${cookieFor("lan", "another-pass-2")}` }));
    expect(res.status).toBe(200);
    expect(fwd(res, ACTOR_HEADER)).toBe("lan");
    expect(fwd(res, ROLE_HEADER)).toBe("clerk");
  });

  it("keeps demo personas working for an owner signed in by session", () => {
    env.CHECKRAIL_DEMO_PERSONAS = "1";
    const res = middleware(page("/", { cookie: `${SESSION_COOKIE}=${cookieFor()}; checkrail_persona=lan` }));
    expect(fwd(res, ACTOR_HEADER)).toBe("lan");
    expect(fwd(res, ROLE_HEADER)).toBe("clerk");
    expect(fwd(res, PERSONA_HEADER)).toBe("judge");
  });

  it("refuses a tampered, expired, forged or stale cookie", () => {
    const good = cookieFor();
    const [u, exp, sig] = good.split(".");
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    const bad = [
      `${u}.${exp}.${flip(sig)}`,
      `${Buffer.from("someone").toString("base64url")}.${exp}.${sig}`,
      `${u}.${(parseInt(exp, 36) + 3600).toString(36)}.${sig}`,
      cookieFor("judge", "a-long-enough-pass", "admin", Date.now() - SESSION_MAX_AGE * 1000 - 1000),
      "garbage",
    ];
    for (const c of bad) expect(middleware(page("/", { cookie: `${SESSION_COOKIE}=${c}` })).status).toBe(303);
    // Signed with another secret.
    env.CHECKRAIL_SESSION_SECRET = "a-different-secret-entirely";
    expect(middleware(page("/", { cookie: `${SESSION_COOKIE}=${good}` })).status).toBe(303);
    env.CHECKRAIL_SESSION_SECRET = "a-session-secret-for-tests";
    expect(middleware(page("/", { cookie: `${SESSION_COOKIE}=${good}` })).status).toBe(200);
    // A changed password ends the session.
    env.CHECKRAIL_USERS = "judge:a-new-long-password:admin";
    expect(middleware(page("/", { cookie: `${SESSION_COOKIE}=${good}` })).status).toBe(303);
  });

  it("expires after 12 hours", () => {
    const users = configuredUsers()!;
    const key = sessionKey(env);
    const t0 = Date.parse("2026-11-02T00:00:00Z");
    const c = signSession(users[0], key!, t0);
    expect(verifySession(c, users, key, t0 + 11.9 * 3600_000)?.user).toBe("judge");
    expect(verifySession(c, users, key, t0 + 12 * 3600_000)).toBeNull();
  });

  it("still accepts the Basic header that scripts send", () => {
    const res = middleware(page("/", { authorization: `Basic ${Buffer.from("judge:a-long-enough-pass").toString("base64")}` }));
    expect(res.status).toBe(200);
    expect(fwd(res, ACTOR_HEADER)).toBe("judge");
  });
});

describe("the session key", () => {
  it("prefers CHECKRAIL_SESSION_SECRET, then the sandbox secret, then the data key; derives one only outside production", () => {
    const k = (e: Record<string, string | undefined>) => sessionKey(e);
    expect(k({ CHECKRAIL_SESSION_SECRET: "x".repeat(16) })).not.toBeNull();
    expect(k({ CHECKRAIL_SESSION_SECRET: "short", CHECKRAIL_SANDBOX_SECRET: "y".repeat(16), NODE_ENV: "production" })).toEqual(k({ CHECKRAIL_SANDBOX_SECRET: "y".repeat(16) }));
    expect(k({ CHECKRAIL_DATA_KEY: "z".repeat(32), NODE_ENV: "production" })).not.toBeNull();
    expect(k({ CHECKRAIL_USERS: "a:b:admin", NODE_ENV: "development" })).not.toBeNull();
    expect(k({ CHECKRAIL_USERS: "a:b:admin", NODE_ENV: "production" })).toBeNull();
  });
});

describe("safe next", () => {
  it("keeps same-origin paths and replaces anything that could leave the site", () => {
    expect(safeNext("/obligations/ob_1?tab=x#h")).toBe("/obligations/ob_1?tab=x#h");
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "\\\\evil.example", "/%0d%0aSet-Cookie:x", "/\tevil", "javascript:alert(1)", "evil.example", "", null, "/signin?next=/x", "/api/signin"]) {
      const out = safeNext(bad);
      expect(out.startsWith("/") && !out.startsWith("//")).toBe(true);
      expect(new URL(out, "http://localhost").host).toBe("localhost");
    }
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(signInUrl("https://evil.example")).toBe("/signin");
  });
});

describe("POST /api/signin", () => {
  it("signs in, sets an httpOnly, secure, SameSite=Lax 12-hour cookie and goes to the page asked for", async () => {
    const res = await signInPost(form({ username: "judge", password: "a-long-enough-pass", next: "/obligations?filter=mine" }, { "x-forwarded-proto": "https" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/obligations?filter=mine");
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).toMatch(new RegExp(`Max-Age=${SESSION_MAX_AGE}`));
    expect(set).not.toContain(SANDBOX_COOKIE);
    // The cookie it set signs the visitor in on the next request.
    const value = set.split(";")[0].split("=").slice(1).join("=");
    expect(fwd(middleware(page("/", { cookie: `${SESSION_COOKIE}=${value}` })), ACTOR_HEADER)).toBe("judge");
  });

  it("never redirects off the site", async () => {
    for (const next of ["https://evil.example/x", "//evil.example", "/\\evil.example"]) {
      const res = await signInPost(form({ username: "judge", password: "a-long-enough-pass", next }, { "x-forwarded-for": "198.51.100.1" }));
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("refuses a post from another site", async () => {
    expect((await signInPost(form({ username: "judge", password: "a-long-enough-pass" }, { origin: "https://evil.example" }))).status).toBe(403);
    // Behind a proxy the request URL is the server's own address; the host the browser used arrives in headers.
    const proxied = { origin: "https://checkrail-pay.onrender.com", host: "checkrail-pay.onrender.com", "x-forwarded-host": "checkrail-pay.onrender.com", "x-forwarded-proto": "https" };
    expect((await signInPost(form({ username: "judge", password: "a-long-enough-pass" }, proxied, "http://localhost:10000/api/signin"))).status).toBe(303);
    expect((await signInPost(form({ username: "judge", password: "a-long-enough-pass" }, { ...proxied, origin: "https://evil.example" }, "http://localhost:10000/api/signin"))).status).toBe(403);
    const noOrigin = new NextRequest("http://localhost/api/signin", { method: "POST", body: "username=judge&password=a-long-enough-pass", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await signInPost(noOrigin)).status).toBe(403);
    expect((await signOutPost(new NextRequest("http://localhost/api/signout", { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
  });

  it("sends a wrong password back to the form, logs it only when asked, and throttles the address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = "203.0.113.150";
    const wrong = () => signInPost(form({ username: "judge", password: "nope", next: "/runs" }, { "x-forwarded-for": ip }));
    const first = await wrong();
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/signin?next=%2Fruns&error=wrong");
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    env.CHECKRAIL_LOG_CLIENT_IP = "1";
    await wrong();
    expect(warn).toHaveBeenCalledWith("[checkrail] failed login", expect.objectContaining({ key: ip }));
    for (let i = 0; i < 9; i++) await wrong();
    const locked = await wrong();
    expect(locked.headers.get("location")).toBe("/signin?next=%2Fruns&error=throttled");
    // Over the limit, a right password is refused too by default.
    const right = () => signInPost(form({ username: "judge", password: "a-long-enough-pass" }, { "x-forwarded-for": ip }));
    expect((await right()).headers.get("location")).toContain("error=throttled");
    // The published judging login is spared, with one account and no real money.
    env.CHECKRAIL_THROTTLE_SPARES_VALID = "1";
    const spared = await right();
    expect(spared.headers.get("location")).toBe("/");
    expect(spared.headers.get("set-cookie")).toContain(SESSION_COOKIE);
    expect((await wrong()).headers.get("location")).toContain("error=throttled");
  });
});

describe("the two counters together", () => {
  it("halves each limit, so form and Basic guesses from one address stay at the old total of ten or so per window", async () => {
    expect(FAIL_LIMIT).toBe(5);
    const ip = "203.0.113.170";
    const formWrong = () => signInPost(form({ username: "judge", password: "nope" }, { "x-forwarded-for": ip }));
    const basicWrong = () => middleware(page("/", { accept: "*/*", authorization: `Basic ${Buffer.from("judge:nope").toString("base64")}`, "x-forwarded-for": ip }));
    const first = await formWrong();
    expect([first.status, first.headers.get("location")]).toEqual([303, "/signin?error=wrong"]);
    let formTries = 1;
    while ((await formWrong()).headers.get("location")?.includes("error=wrong")) formTries++;
    let basicTries = 0;
    while (basicWrong().status === 401) basicTries++;
    // Each store counts up to its limit plus the attempt that crosses it; the next one is refused.
    expect(formTries).toBe(FAIL_LIMIT + 1);
    expect(basicTries).toBe(FAIL_LIMIT + 1);
    expect(formTries + basicTries).toBeLessThanOrEqual(12);
    expect(basicWrong().status).toBe(429);
  });
});

describe("redirects from middleware", () => {
  it("are absolute, because the production build rejects a bare path and the page answers 500", () => {
    const res = middleware(page("/onboarding/dashboard"));
    expect(res.headers.get("location")).toMatch(/^https?:\/\//);
  });

  it("use the host and protocol the browser used when a proxy forwards them", () => {
    const res = middleware(page("/runs", { "x-forwarded-host": "checkrail-pay.onrender.com", "x-forwarded-proto": "https" }));
    expect(res.headers.get("location")).toBe("https://checkrail-pay.onrender.com/signin?next=%2Fruns");
  });
});

describe("the sign-in page itself", () => {
  it("sends a visitor who is already signed in straight on to next", () => {
    const res = middleware(page("/signin?next=%2Fruns", { cookie: `${SESSION_COOKIE}=${cookieFor()}` }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/runs");
    expect(middleware(page("/signin?next=https%3A%2F%2Fevil.example", { cookie: `${SESSION_COOKIE}=${cookieFor()}` })).headers.get("location")).toBe("http://localhost/");
  });

  it("answers Origin null with a friendly page, not a bare 403", async () => {
    const res = await signInPost(form({ username: "judge", password: "a-long-enough-pass" }, { origin: "null" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Sign in again");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/signout", () => {
  it("clears the cookie and returns to the sign-in page", async () => {
    const res = await signOutPost(new NextRequest("http://localhost/api/signout", { method: "POST", headers: { origin: "http://localhost" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, "i"));
  });
});
