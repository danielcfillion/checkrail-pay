import { describe, it, expect, vi, afterEach } from "vitest";
import { PayPalRail } from "./paypal";
import type { ExecutionRequest, VendorPayoutProfile } from "../domain/types";

const creds = { clientId: "id", clientSecret: "s3cret", env: "sandbox" as const, webhookId: "WH-1" };

const vendor: VendorPayoutProfile = {
  id: "v1", name: "Maria Santos", country: "PH", preferredRail: null, paypalEmail: "maria@example.com", stellarAccount: null,
  bankCountry: "PH", bankCurrency: "PHP", bankLabel: "BDO ****1234", detailsHash: "h", verifiedAt: "2026-09-01T00:00:00Z",
};
const req: ExecutionRequest = { obligationId: "obl_1", idempotencyKey: "k".repeat(32), vendor, amountMinor: 18_000, currency: "USD", memo: "JOB-1 abcd1234", businessCountry: "US" };

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    return handler(url, init);
  });
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("PayPalRail.execute outcome classification", () => {
  it("sends an exact decimal amount, the batch id and the request id, and uses the sandbox host", async () => {
    const calls = stubFetch(() => json(201, { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING" } }));
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("submitted");
    expect(r.externalId).toBe("PB1");
    expect(r.note).toMatch(/modelled/);
    const post = calls.find((c) => c.url.includes("/v1/payments/payouts"))!;
    expect(post.url.startsWith("https://api-m.sandbox.paypal.com")).toBe(true);
    const body = JSON.parse(post.init.body as string);
    expect(body.items[0].amount).toEqual({ value: "180.00", currency: "USD" });
    expect(body.sender_batch_header.sender_batch_id).toBe(req.idempotencyKey);
    expect((post.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(req.idempotencyKey);
    expect(post.init.signal).toBeDefined(); // hard timeout
  });

  it("uses the live host only when PAYPAL_ENV is live", async () => {
    const calls = stubFetch(() => json(201, { batch_header: { payout_batch_id: "PB1" } }));
    await new PayPalRail({ ...creds, env: "live" }).execute(req);
    expect(calls.every((c) => c.url.startsWith("https://api-m.paypal.com"))).toBe(true);
  });

  it("a timeout is unknown, not failed", async () => {
    stubFetch(() => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); });
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("unknown");
    expect(r.errorMessage).toMatch(/timeout/);
  });

  it("5xx, 408 and unreadable bodies are unknown", async () => {
    for (const res of [json(503, { name: "SERVICE_UNAVAILABLE" }), json(408, {}), new Response("<html>bad gateway</html>", { status: 400 })]) {
      stubFetch(() => res.clone());
      expect((await new PayPalRail(creds).execute(req)).status).toBe("unknown");
    }
  });

  it("a 2xx with no batch id is unknown", async () => {
    stubFetch(() => json(201, { something: "else" }));
    expect((await new PayPalRail(creds).execute(req)).status).toBe("unknown");
  });

  it("a 4xx with a PayPal error body is a definitive failure", async () => {
    stubFetch(() => json(422, { name: "INSUFFICIENT_FUNDS", message: "Sender has insufficient funds" }));
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toMatch(/INSUFFICIENT_FUNDS/);
  });

  it("a reused sender_batch_id is not a failure: the original batch is looked up and reported as submitted", async () => {
    const calls = stubFetch((url, init) => {
      if (init.method === "POST") return json(400, { name: "USER_BUSINESS_ERROR", message: "Request rejected", details: [{ issue: "SENDER_BATCH_ID_ALREADY_EXISTS" }] });
      if (url.includes("/v1/payments/payouts?sender_batch_id=")) return json(200, { batch_header: { payout_batch_id: "PB-ORIGINAL", batch_status: "SUCCESS" } });
      return json(404, {});
    });
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("submitted");
    expect(r.externalId).toBe("PB-ORIGINAL");
    expect(calls.some((c) => c.url.includes(`sender_batch_id=${"k".repeat(32)}`))).toBe(true);
  });

  it("a duplicate rejection whose lookup finds nothing stays unknown, never failed", async () => {
    stubFetch((url, init) => {
      if (init.method === "POST") return json(400, { name: "USER_BUSINESS_ERROR", message: "sender_batch_id already exists" });
      return new Response("", { status: 503 });
    });
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("unknown");
  });

  it("findByIdempotencyKey returns null when PayPal has no such batch", async () => {
    stubFetch(() => json(404, { name: "RESOURCE_NOT_FOUND" }));
    expect(await new PayPalRail(creds).findByIdempotencyKey("abc")).toBeNull();
  });

  it("an authentication failure is definitive and nothing is posted", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return json(401, {});
    });
    const r = await new PayPalRail(creds).execute(req);
    expect(r.status).toBe("failed");
    expect(calls.every((u) => u.endsWith("/v1/oauth2/token"))).toBe(true);
  });

  it("refuses unsupported currencies and non-integer amounts before calling PayPal", async () => {
    const calls = stubFetch(() => json(201, {}));
    expect((await new PayPalRail(creds).execute({ ...req, currency: "JPY" })).status).toBe("failed");
    expect((await new PayPalRail(creds).execute({ ...req, amountMinor: 12.5 })).status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("PayPalRail.getStatus (H8)", () => {
  const statusFor = async (batch: string, item: string) => {
    stubFetch(() => json(200, { batch_header: { batch_status: batch }, items: [{ transaction_status: item }] }));
    return new PayPalRail(creds).getStatus("PB1");
  };

  it("UNCLAIMED and ONHOLD are exceptions with a clear message", async () => {
    const u = await statusFor("SUCCESS", "UNCLAIMED");
    expect(u.status).toBe("exception");
    expect(u.message).toMatch(/UNCLAIMED.*30 days/);
    const h = await statusFor("PROCESSING", "ONHOLD");
    expect(h.status).toBe("exception");
    expect(h.message).toMatch(/ON HOLD/);
  });

  it("SUCCESS confirms; returned or blocked money fails; the rest is pending", async () => {
    expect((await statusFor("SUCCESS", "SUCCESS")).status).toBe("confirmed");
    for (const s of ["RETURNED", "BLOCKED", "FAILED", "REFUNDED", "REVERSED", "DENIED", "CANCELED"]) expect((await statusFor("SUCCESS", s)).status).toBe("failed");
    expect((await statusFor("PENDING", "PENDING")).status).toBe("pending");
  });

  it("a transport error leaves the status pending", async () => {
    stubFetch(() => { throw new Error("ECONNRESET"); });
    expect((await new PayPalRail(creds).getStatus("PB1")).status).toBe("pending");
  });
});

describe("PayPalRail.verifyWebhook", () => {
  const headers = { "paypal-auth-algo": "a", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-transmission-time": "now" };

  it("fails closed with missing headers, bad JSON or no webhook id, without calling PayPal", async () => {
    const calls = stubFetch(() => json(200, { verification_status: "SUCCESS" }));
    const rail = new PayPalRail(creds);
    expect(await rail.verifyWebhook({ ...headers, "paypal-transmission-sig": "" }, "{}")).toBe(false);
    expect(await rail.verifyWebhook(headers, "not json")).toBe(false);
    expect(await new PayPalRail({ ...creds, webhookId: "" }).verifyWebhook(headers, "{}")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("accepts only an explicit SUCCESS", async () => {
    stubFetch(() => json(200, { verification_status: "SUCCESS" }));
    expect(await new PayPalRail(creds).verifyWebhook(headers, "{}")).toBe(true);
    stubFetch(() => json(200, { verification_status: "FAILURE" }));
    expect(await new PayPalRail(creds).verifyWebhook(headers, "{}")).toBe(false);
  });
});
