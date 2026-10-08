import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { ACTOR_HEADER, checkBasicAuth, parseCredential, safeEqual } from "./basicAuth";
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
  const prev = process.env.CHECKRAIL_BASIC_AUTH;
  const prevOld = process.env.DUELINE_BASIC_AUTH;
  afterEach(() => {
    if (prev === undefined) delete process.env.CHECKRAIL_BASIC_AUTH;
    else process.env.CHECKRAIL_BASIC_AUTH = prev;
    if (prevOld === undefined) delete process.env.DUELINE_BASIC_AUTH;
    else process.env.DUELINE_BASIC_AUTH = prevOld;
  });
  const req = (headers: Record<string, string> = {}) => new NextRequest("http://localhost/obligations", { headers });

  it("is a no-op when CHECKRAIL_BASIC_AUTH is unset, and strips a client-supplied actor header", () => {
    delete process.env.CHECKRAIL_BASIC_AUTH;
    const res = middleware(req({ [ACTOR_HEADER]: "forged" }));
    expect(res.status).toBe(200);
    expect(res.headers.get(`x-middleware-request-${ACTOR_HEADER}`)).toBeNull();
    expect((res.headers.get("x-middleware-override-headers") ?? "").split(",")).not.toContain(ACTOR_HEADER); // the forged header is not forwarded to the app
  });

  it("returns 401 with a challenge when auth is on and credentials are missing or wrong", () => {
    process.env.CHECKRAIL_BASIC_AUTH = "rianne:pw";
    const none = middleware(req());
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toMatch(/^Basic/);
    expect(middleware(req({ authorization: basic("rianne", "nope") })).status).toBe(401);
  });

  it("passes the authenticated username to the app and ignores a forged actor header", () => {
    process.env.CHECKRAIL_BASIC_AUTH = "rianne:pw";
    const res = middleware(req({ authorization: basic("rianne", "pw"), [ACTOR_HEADER]: "daniel" }));
    expect(res.status).toBe(200);
    expect(res.headers.get(`x-middleware-request-${ACTOR_HEADER}`)).toBe("rianne");
  });

  it("still enforces auth when only the pre-rename variable DUELINE_BASIC_AUTH is set", () => {
    delete process.env.CHECKRAIL_BASIC_AUTH;
    process.env.DUELINE_BASIC_AUTH = "rianne:pw";
    expect(middleware(req()).status).toBe(401);
    const ok = middleware(req({ authorization: basic("rianne", "pw") }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get(`x-middleware-request-${ACTOR_HEADER}`)).toBe("rianne");
  });

  it("refuses everything when the setting is malformed, instead of leaving the app open", () => {
    process.env.CHECKRAIL_BASIC_AUTH = "oops";
    expect(middleware(req()).status).toBe(503);
    expect(middleware(req({ authorization: basic("oops", "") })).status).toBe(503);
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
