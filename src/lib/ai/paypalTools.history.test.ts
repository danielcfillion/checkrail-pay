import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { listPayPalTransactionsRaw } from "./paypalTools";

vi.mock("../rails/paypalAuth", () => ({ fetchPayPalAccessToken: async () => ({ token: "t" }) }));

// config is read-only in the types; the test switches the PayPal rail to "live" and puts it back.
const rails = config.rails as unknown as { mode: string; paypal: { clientId: string | undefined; clientSecret: string | undefined } };
const saved = { mode: rails.mode, id: rails.paypal.clientId, secret: rails.paypal.clientSecret };
beforeEach(() => {
  rails.mode = "live";
  rails.paypal.clientId = "id";
  rails.paypal.clientSecret = "secret";
});
afterEach(() => {
  rails.mode = saved.mode;
  rails.paypal.clientId = saved.id;
  rails.paypal.clientSecret = saved.secret;
  vi.restoreAllMocks();
});

const tx = (id: string) => ({ transaction_info: { transaction_id: id } });
/** Answer each successive request from the script: a page of results, or an HTTP status. */
function serve(script: (n: number) => { details: unknown[]; total_pages: number } | number) {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    urls.push(String(url));
    const r = script(urls.length);
    if (typeof r === "number") return new Response("{}", { status: r });
    return new Response(JSON.stringify({ transaction_details: r.details, total_pages: r.total_pages }), { status: 200 });
  });
  return urls;
}

describe("PayPal history read for the duplicate check (SEC5-5)", () => {
  it("follows every page and returns them together", async () => {
    const urls = serve((n) => ({ details: [tx(`a${n}`), tx(`b${n}`)], total_pages: 3 }));
    const out = await listPayPalTransactionsRaw();
    expect(out.ok).toBe(true);
    expect((JSON.parse(out.body) as { transaction_details: unknown[] }).transaction_details).toHaveLength(6);
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => /page=(\d+)/.exec(u)![1])).toEqual(["1", "2", "3"]);
  });

  it("reports a failed page as unreadable instead of passing on the pages it did get", async () => {
    serve((n) => (n === 2 ? 503 : { details: [tx("a")], total_pages: 3 }));
    expect(await listPayPalTransactionsRaw()).toMatchObject({ ok: false, error: "HTTP 503" });
  });

  it("says the history is incomplete when it is longer than the pages it reads", async () => {
    serve(() => ({ details: [tx("a")], total_pages: 50 }));
    const out = await listPayPalTransactionsRaw();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/more than 5000 transactions in 31 days; the history is incomplete/);
  });
});
