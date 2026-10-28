import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER, checkBasicAuth, parseCredential, safeEqual } from "./basicAuth";
import { middleware } from "../middleware";
import { resetDemoAction } from "../app/actions";
import { config } from "./config";

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("basic auth helpers (C3)", () => {
  it("parses user:pass and keeps colons in the password", () => {
    expect(parseCredential("rianne:s3:cret")).toEqual({ user: "rianne", pass: "s3:cret" });
    for (const bad of [undefined, "", "nocolon", ":nopass", "user:", "bad user:pw", "u$er:pw"]) expect(parseCredential(bad as string)).toBeNull();
  });

  it("accepts the right credential and returns the username", () => {
    expect(checkBasicAuth(basic("rianne", "pw"), "rianne:pw")).toBe("rianne");
  });

  it("rejects wrong user, wrong password, wrong scheme, junk and missing headers", () => {
    const s = "rianne:pw";
    expect(checkBasicAuth(basic("daniel", "pw"), s)).toBeNull();
    expect(checkBasicAuth(basic("rianne", "PW"), s)).toBeNull();
    expect(checkBasicAuth(basic("rianne", "pw "), s)).toBeNull();
    expect(checkBasicAuth("Bearer abc", s)).toBeNull();
    expect(checkBasicAuth("Basic !!!notbase64", s)).toBeNull();
    expect(checkBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, s)).toBeNull();
    expect(checkBasicAuth(null, s)).toBeNull();
    expect(checkBasicAuth(basic("rianne", "pw"), "malformed")).toBeNull();
  });

  it("compares in full without an early exit", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("middleware", () => {
  const keys = ["CHECKRAIL_BASIC_AUTH", "DUELINE_BASIC_AUTH", "CHECKRAIL_USERS", "CHECKRAIL_INSECURE_DEMO", "CHECKRAIL_DEMO_PERSONAS", "RAIL_MODE", "PAYPAL_ENV"] as const;
  const saved: Record<string, string | undefined> = {};
  const env = process.env as Record<string, string | undefined>;
  beforeEach(() => {
    for (const k of keys) saved[k] = env[k];
    for (const k of keys) delete env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
    env.NODE_ENV = "test";
  });
  const req = (headers: Record<string, string> = {}, path = "/obligations") => new NextRequest(`http://localhost${path}`, { headers });
  const fwd = (res: Response, h: string) => res.headers.get(`x-middleware-request-${h}`);

  it("open in development: acts as the demo owner and ignores forged identity headers", () => {
    const res = middleware(req({ [ACTOR_HEADER]: "forged", [ROLE_HEADER]: "admin" }));
    expect(res.status).toBe(200);
    expect(fwd(res, ACTOR_HEADER)).toBe("daniel");
    expect(fwd(res, ROLE_HEADER)).toBe("admin");
  });

  it("refuses to run open in production or with live rails (security audit F3)", () => {
    env.NODE_ENV = "production";
    expect(middleware(req()).status).toBe(503);
    env.CHECKRAIL_INSECURE_DEMO = "1";
    expect(middleware(req()).status).toBe(200);
    env.RAIL_MODE = "live";
    expect(middleware(req()).status).toBe(503);
  });

  it("returns 401 with a challenge when auth is on and credentials are missing or wrong", () => {
    env.CHECKRAIL_BASIC_AUTH = "rianne:pw";
    const none = middleware(req());
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toMatch(/^Basic/);
    expect(middleware(req({ authorization: basic("rianne", "nope") })).status).toBe(401);
  });

  it("the single credential is an admin and a forged actor or role header is overwritten", () => {
    env.CHECKRAIL_BASIC_AUTH = "rianne:pw";
    const res = middleware(req({ authorization: basic("rianne", "pw"), [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "clerk" }));
    expect(res.status).toBe(200);
    expect(fwd(res, ACTOR_HEADER)).toBe("rianne");
    expect(fwd(res, ROLE_HEADER)).toBe("admin");
  });

  it("named users get their own role", () => {
    env.CHECKRAIL_USERS = "minh:pw1:approver,lan:pw2:clerk";
    const lan = middleware(req({ authorization: basic("lan", "pw2") }));
    expect(fwd(lan, ACTOR_HEADER)).toBe("lan");
    expect(fwd(lan, ROLE_HEADER)).toBe("clerk");
    expect(middleware(req({ authorization: basic("lan", "pw1") })).status).toBe(401);
  });

  it("still enforces auth when only the pre-rename variable DUELINE_BASIC_AUTH is set", () => {
    env.DUELINE_BASIC_AUTH = "rianne:pw";
    expect(middleware(req()).status).toBe(401);
    const ok = middleware(req({ authorization: basic("rianne", "pw") }));
    expect(ok.status).toBe(200);
    expect(fwd(ok, ACTOR_HEADER)).toBe("rianne");
  });

  it("refuses everything when a setting is malformed, instead of leaving the app open", () => {
    env.CHECKRAIL_BASIC_AUTH = "oops";
    expect(middleware(req()).status).toBe(503);
    delete env.CHECKRAIL_BASIC_AUTH;
    env.CHECKRAIL_USERS = "minh:pw:boss";
    expect(middleware(req()).status).toBe(503);
  });

  it("demo personas apply only when switched on and never with real money", () => {
    env.CHECKRAIL_USERS = "judge:pw:admin";
    const asLan = { authorization: basic("judge", "pw"), cookie: "checkrail_persona=lan" };
    expect(fwd(middleware(req(asLan)), ACTOR_HEADER)).toBe("judge");
    env.CHECKRAIL_DEMO_PERSONAS = "1";
    const res = middleware(req(asLan));
    expect(fwd(res, ACTOR_HEADER)).toBe("lan");
    expect(fwd(res, ROLE_HEADER)).toBe("clerk");
    expect(fwd(res, PERSONA_HEADER)).toBe("judge");
    env.PAYPAL_ENV = "live";
    expect(fwd(middleware(req(asLan)), ACTOR_HEADER)).toBe("judge");
  });

  it("only an owner login can act as someone else", () => {
    env.CHECKRAIL_USERS = "lan:pw:clerk";
    env.CHECKRAIL_DEMO_PERSONAS = "1";
    const res = middleware(req({ authorization: basic("lan", "pw"), cookie: "checkrail_persona=daniel" }));
    expect(fwd(res, ACTOR_HEADER)).toBe("lan");
    expect(fwd(res, ROLE_HEADER)).toBe("clerk");
    expect(fwd(res, PERSONA_HEADER)).toBeNull();
  });

  it("exempts only the exact webhook path and token-shaped vendor pages (security audit F11)", () => {
    env.CHECKRAIL_BASIC_AUTH = "rianne:pw";
    expect(middleware(req({}, "/api/webhooks/paypal")).status).toBe(200);
    expect(middleware(req({}, "/api/webhooks/paypalx")).status).toBe(401);
    expect(middleware(req({}, "/favicon.icox")).status).toBe(401);
    expect(middleware(req({}, "/onboard/" + "a".repeat(32))).status).toBe(200);
    expect(middleware(req({}, "/onboard/short")).status).toBe(401);
  });
});

describe("demo reset (C3a)", () => {
  it("refuses when RAIL_MODE=live, before touching the database", async () => {
    const rails = config.rails as { mode: string };
    const prev = rails.mode;
    rails.mode = "live";
    try {
      const r = await resetDemoAction();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/disabled when RAIL_MODE=live/);
    } finally {
      rails.mode = prev;
    }
  });
});
