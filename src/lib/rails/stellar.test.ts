import { describe, it, expect } from "vitest";
import { Account, Keypair, type Horizon } from "@stellar/stellar-sdk";
import { StellarRail } from "./stellar";
import { TESTNET_PYUSD_ISSUER } from "../config";
import type { ExecutionRequest, VendorPayoutProfile } from "../domain/types";

const treasury = Keypair.random();
const dest = Keypair.random().publicKey();
const issuer = TESTNET_PYUSD_ISSUER;
const cfg = { network: "testnet" as const, horizonUrl: "https://horizon-testnet.stellar.org", treasurySecret: treasury.secret(), pyusdIssuer: issuer, pyusdCode: "PYUSD" };

const vendor = (over: Partial<VendorPayoutProfile> = {}): VendorPayoutProfile => ({
  id: "v1", name: "Ana Reyes", country: "PH", preferredRail: "stellar", paypalEmail: null, stellarAccount: dest,
  bankCountry: "PH", bankCurrency: "PHP", bankLabel: "UnionBank ****0923", detailsHash: "h", verifiedAt: "2026-09-01T00:00:00Z", ...over,
});
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const request = (over: Partial<ExecutionRequest> = {}): ExecutionRequest => ({ obligationId: "obl_1", idempotencyKey: KEY, vendor: vendor(), amountMinor: 75_000, currency: "USD", memo: KEY.slice(0, 28), businessCountry: "US", ...over });

type Rec = { hash: string; memo_type: string; memo: string; successful: boolean; created_at: string; ops: Array<Record<string, unknown>> };
const payment = (over: Record<string, unknown> = {}) => ({ type: "payment", to: dest, amount: "750.0000000", asset_code: "PYUSD", asset_issuer: issuer, ...over });
const rec = (over: Partial<Rec> = {}): Rec => ({ hash: "H-OLD", memo_type: "text", memo: KEY.slice(0, 28), successful: true, created_at: new Date().toISOString(), ops: [payment()], ...over });

interface FakeOpts {
  pages?: Rec[][];            // history, newest first, one array per page
  historyError?: Error;
  submit?: (tx: { hash(): Uint8Array }) => Promise<{ hash: string; ledger: number; successful: boolean }>;
  loadError?: Error;
}
function fakeServer(o: FakeOpts = {}) {
  const log: string[] = [];
  const pages = o.pages ?? [[]];
  const mkPage = (i: number): unknown => ({
    records: pages[i].map((r) => ({ ...r, operations: async () => ({ records: r.ops }) })),
    next: async () => mkPage(i + 1),
  });
  const server = {
    loadAccount: async () => {
      log.push("load");
      if (o.loadError) throw o.loadError;
      return new Account(treasury.publicKey(), "100");
    },
    transactions: () => ({
      forAccount: () => ({ order: () => ({ limit: () => ({ call: async () => { log.push("history"); if (o.historyError) throw o.historyError; return mkPage(0); } }) }) }),
      transaction: (hash: string) => ({ call: async () => ({ hash, fee_charged: "100", successful: true }) }),
    }),
    submitTransaction: async (tx: { hash(): Uint8Array }) => {
      log.push("submit");
      if (o.submit) return o.submit(tx);
      return { hash: Buffer.from(tx.hash()).toString("hex"), ledger: 7, successful: true };
    },
  };
  return { server: server as unknown as Horizon.Server, log };
}
const rail = (o: FakeOpts = {}) => {
  const f = fakeServer(o);
  return { rail: new StellarRail(cfg, { server: f.server }), log: f.log };
};

describe("StellarRail construction (M8)", () => {
  it("refuses the testnet issuer on the public network", () => {
    expect(() => new StellarRail({ ...cfg, network: "public", horizonUrl: "https://horizon.stellar.org" })).toThrow(/testnet issuer/);
  });
  it("refuses a testnet Horizon URL on the public network and a public one on testnet", () => {
    const mainIssuer = Keypair.random().publicKey();
    expect(() => new StellarRail({ ...cfg, network: "public", pyusdIssuer: mainIssuer })).toThrow(/testnet/);
    expect(() => new StellarRail({ ...cfg, horizonUrl: "https://horizon.stellar.org" })).toThrow(/public network/);
    expect(() => new StellarRail({ ...cfg, network: "public", pyusdIssuer: mainIssuer, horizonUrl: "https://horizon.stellar.org" })).not.toThrow();
  });
  it("rejects a bad secret without echoing it", () => {
    const bad = "SNOTAREALSECRETKEYTHATSHOULDNEVERBEPRINTED";
    try {
      new StellarRail({ ...cfg, treasurySecret: bad });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/not a valid Stellar secret key/);
      expect((e as Error).message).not.toContain(bad);
    }
  });
});

describe("StellarRail.execute validation (M7)", () => {
  it("rejects malformed, muxed, treasury and issuer destinations without touching the network", async () => {
    for (const bad of ["GNOTVALID", "not-an-address", "M" + "A".repeat(68), treasury.publicKey(), issuer, ""]) {
      const { rail: r, log } = rail();
      const out = await r.execute(request({ vendor: vendor({ stellarAccount: bad || null }) }));
      expect(out.status).toBe("failed");
      expect(log).toEqual([]);
    }
  });
  it("rejects unsafe amounts and non-USD currency", async () => {
    const { rail: r, log } = rail();
    for (const amountMinor of [12.5, 0, -1, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) expect((await r.execute(request({ amountMinor }))).status).toBe("failed");
    expect((await r.execute(request({ currency: "EUR" }))).status).toBe("failed");
    expect(log).toEqual([]);
  });
});

describe("StellarRail.execute happy path", () => {
  it("sends an exact 7-decimal amount and records what was sent, with the hash stored before submit", async () => {
    let stored: string | null = null;
    let amountSeen = "";
    const f = fakeServer({
      submit: async (tx) => {
        const t = tx as unknown as { operations: Array<{ amount: string }> };
        amountSeen = t.operations[0].amount;
        return { hash: Buffer.from(tx.hash()).toString("hex"), ledger: 9, successful: true };
      },
    });
    const r = new StellarRail(cfg, { server: f.server });
    const out = await r.execute(request({ beforeSubmit: (i) => { stored = i.externalId; f.log.push("persist"); } }));
    expect(out.status).toBe("confirmed");
    expect(amountSeen).toBe("750.0000000");
    expect(stored).toBe(out.externalId);
    expect(f.log).toEqual(["load", "history", "persist", "submit"]); // account loaded before history; hash persisted before submit
    // Actual ledger result, not the modelled PHP figure.
    expect(out.receivedCurrency).toBe("PYUSD");
    expect(out.receivedMinor).toBe(75_000);
    expect(out.fxRate).toBe("1");
    expect(out.note).toMatch(/100 stroops/);
    expect(out.note).toMatch(/modelled, not executed/);
  });

  it("formats awkward cent values exactly", async () => {
    const seen: string[] = [];
    const f = fakeServer({ submit: async (tx) => { seen.push((tx as unknown as { operations: Array<{ amount: string }> }).operations[0].amount); return { hash: "H", ledger: 1, successful: true }; } });
    const r = new StellarRail(cfg, { server: f.server });
    for (const m of [1, 7, 10, 105, 1999, 123_456_789]) await r.execute(request({ amountMinor: m, idempotencyKey: String(m).padStart(32, "0") }));
    expect(seen).toEqual(["0.0100000", "0.0700000", "0.1000000", "1.0500000", "19.9900000", "1234567.8900000"]);
  });

  it("does not add a modelled-anchor note for a plain wallet payment", async () => {
    const { rail: r } = rail();
    const out = await r.execute(request({ vendor: vendor({ country: "US", bankCountry: "US", bankCurrency: "USD" }) }));
    expect(out.status).toBe("confirmed");
    expect(out.note).not.toMatch(/modelled/);
  });
});

describe("StellarRail duplicate protection (H2)", () => {
  it("returns the earlier payment and does not submit when memo, destination, asset and amount match", async () => {
    const { rail: r, log } = rail({ pages: [[rec()]] });
    const out = await r.execute(request());
    expect(out.status).toBe("confirmed");
    expect(out.externalId).toBe("H-OLD");
    expect(log).not.toContain("submit");
  });

  it("finds the payment on a later page (beyond the first 200)", async () => {
    const filler = Array.from({ length: 200 }, (_, i) => rec({ hash: `F${i}`, memo: `other-${i}`, ops: [] }));
    const { rail: r, log } = rail({ pages: [filler, filler, [rec({ hash: "H-DEEP" })]] });
    const out = await r.execute(request());
    expect(out.externalId).toBe("H-DEEP");
    expect(log).not.toContain("submit");
  });

  it("does not treat a memo match with a different destination, amount or asset as a duplicate", async () => {
    for (const ops of [[payment({ to: Keypair.random().publicKey() })], [payment({ amount: "1.0000000" })], [payment({ asset_issuer: Keypair.random().publicKey() })], [payment({ type: "create_account" })]]) {
      const { rail: r, log } = rail({ pages: [[rec({ ops })]] });
      const out = await r.execute(request());
      expect(out.externalId).not.toBe("H-OLD");
      expect(log).toContain("submit");
    }
  });

  it("ignores a failed transaction with the same memo", async () => {
    const { rail: r, log } = rail({ pages: [[rec({ successful: false })]] });
    await r.execute(request());
    expect(log).toContain("submit");
  });

  it("fails closed: if history cannot be read it does not send, and reports unknown", async () => {
    const { rail: r, log } = rail({ historyError: new Error("horizon 503") });
    const out = await r.execute(request());
    expect(out.status).toBe("unknown");
    expect(log).not.toContain("submit");
  });

  it("also does not send when the treasury account cannot be loaded", async () => {
    const { rail: r, log } = rail({ loadError: new Error("ECONNRESET") });
    expect((await r.execute(request())).status).toBe("unknown");
    expect(log).not.toContain("submit");
  });
});

describe("StellarRail submission outcomes (C1)", () => {
  it("result codes mean the network rejected it: failed, with the codes surfaced (op_no_trust)", async () => {
    const { rail: r } = rail({ submit: async () => { throw Object.assign(new Error("Request failed"), { response: { data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_trust"] } } } } }); } });
    const out = await r.execute(request());
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toMatch(/op_no_trust/);
  });

  it("a timeout is unknown and carries the transaction hash so it can be looked up", async () => {
    let persisted: string | null = null;
    const { rail: r } = rail({ submit: async () => { throw Object.assign(new Error("timeout of 60000ms exceeded"), { response: { status: 504, data: { title: "Timeout" } } }); } });
    const out = await r.execute(request({ beforeSubmit: (i) => { persisted = i.externalId; } }));
    expect(out.status).toBe("unknown");
    expect(out.externalId).toBeTruthy();
    expect(out.externalId).toBe(persisted);
    expect(out.errorMessage).toContain(out.externalId!);
  });

  it("a dropped connection with no response at all is unknown", async () => {
    const { rail: r } = rail({ submit: async () => { throw new Error("socket hang up"); } });
    expect((await r.execute(request())).status).toBe("unknown");
  });

  it("if persisting the hash fails, nothing is submitted", async () => {
    const { rail: r, log } = rail();
    const out = await r.execute(request({ beforeSubmit: () => { throw new Error("db locked"); } }));
    expect(out.status).toBe("unknown");
    expect(log).not.toContain("submit");
  });
});

describe("StellarRail sequence handling (H5)", () => {
  it("serialises concurrent payments so they never build from the same sequence number", async () => {
    const order: string[] = [];
    const f = fakeServer({
      submit: async (tx) => {
        order.push("submit-start");
        await new Promise((r) => setTimeout(r, 15));
        order.push("submit-end");
        return { hash: Buffer.from(tx.hash()).toString("hex"), ledger: 1, successful: true };
      },
    });
    const r = new StellarRail(cfg, { server: f.server });
    const [a, b] = await Promise.all([r.execute(request({ idempotencyKey: "1".repeat(32) })), r.execute(request({ idempotencyKey: "2".repeat(32) }))]);
    expect(a.status).toBe("confirmed");
    expect(b.status).toBe("confirmed");
    expect(order).toEqual(["submit-start", "submit-end", "submit-start", "submit-end"]);
  });
});
