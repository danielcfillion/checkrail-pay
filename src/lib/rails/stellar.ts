import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ExecutionRequest, ExecutionResult, PaymentRail, RailBalance, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { config, TESTNET_PYUSD_ISSUER } from "../config";
import { isValidAmountMinor, minorToDecimal } from "../domain/money";
import { quoteStellar } from "./quoteModel";

/**
 * Live Stellar adapter (testnet or public, chosen by STELLAR_NETWORK).
 *
 * Money path. Review every change here by hand.
 *
 * Execution sends PYUSD from the treasury account to the destination with the
 * attempt's idempotency key (first 28 chars) as the transaction memo. On testnet
 * the destination is the vendor's Stellar account (the demo recipient). The
 * anchor leg for bank payouts (PYUSD to USDC swap, SEP-31 off-ramp) is NOT
 * implemented: the quote for such corridors is flagged `modelled`, and the
 * settlement records what actually happened on the ledger (PYUSD sent), not
 * the modelled recipient-currency figure.
 *
 * Duplicate protection, in order:
 *   1. The treasury account is loaded first, then its history is searched for a
 *      successful payment with this memo, this destination, this asset and this
 *      amount. Loading first matters: an earlier submission that has not landed yet
 *      carries the same sequence number as the one we are about to build, so only
 *      one of the two can ever apply.
 *   2. If the history cannot be read, we do not send. The outcome is "unknown".
 *   3. The signed transaction's hash is handed to `beforeSubmit` so the engine
 *      stores it before the network sees the transaction. After an ambiguous
 *      error the payment can be looked up by that hash.
 *   4. Submissions are serialised in-process so two payments cannot reuse a sequence number.
 */
const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGES = 25;
const HISTORY_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

type OpRecord = { type?: string; to?: string; amount?: string; asset_code?: string; asset_issuer?: string };

export class StellarRail implements PaymentRail {
  readonly rail = "stellar" as const;
  readonly mode: "testnet" | "live";
  private readonly server: Horizon.Server;
  private readonly passphrase: string;
  private readonly treasury: Keypair;
  private readonly asset: Asset;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg = config.rails.stellar, deps: { server?: Horizon.Server } = {}) {
    this.mode = cfg.network === "public" ? "live" : "testnet";
    this.passphrase = this.mode === "live" ? Networks.PUBLIC : Networks.TESTNET;
    if (!cfg.treasurySecret) throw new Error("StellarRail requires STELLAR_TREASURY_SECRET");
    try {
      this.treasury = Keypair.fromSecret(cfg.treasurySecret);
    } catch {
      // Do not echo the underlying error: it can include the offending value.
      throw new Error("STELLAR_TREASURY_SECRET is not a valid Stellar secret key");
    }
    if (!StrKey.isValidEd25519PublicKey(cfg.pyusdIssuer)) throw new Error("STELLAR_PYUSD_ISSUER is not a valid Stellar public key");
    const horizonIsPublic = /^https:\/\/horizon\.stellar\.org/i.test(cfg.horizonUrl);
    if (this.mode === "live") {
      if (cfg.pyusdIssuer === TESTNET_PYUSD_ISSUER) throw new Error("STELLAR_NETWORK=public but STELLAR_PYUSD_ISSUER is the testnet issuer; set the mainnet PYUSD issuer");
      if (!horizonIsPublic && /testnet/i.test(cfg.horizonUrl)) throw new Error("STELLAR_NETWORK=public but STELLAR_HORIZON_URL points at testnet");
    } else if (horizonIsPublic) {
      throw new Error("STELLAR_NETWORK is testnet but STELLAR_HORIZON_URL points at the public network");
    }
    this.server = deps.server ?? new Horizon.Server(cfg.horizonUrl);
    this.asset = new Asset(cfg.pyusdCode, cfg.pyusdIssuer);
  }

  get treasuryPublicKey(): string {
    return this.treasury.publicKey();
  }

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return quoteStellar(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (req.currency !== "USD") return fail(`Stellar rail settles USD-denominated obligations only (got ${req.currency})`);
    if (!isValidAmountMinor(req.amountMinor)) return fail(`Invalid amount ${req.amountMinor}`);
    const destination = this.resolveDestination(req.vendor);
    if (!destination) return fail("Vendor has no Stellar destination (wallet or anchor) on file");
    if (!StrKey.isValidEd25519PublicKey(destination)) return fail("Vendor's Stellar destination is not a valid account address (expected a G... public key)");
    if (destination === this.treasury.publicKey() || destination === this.cfg.pyusdIssuer) return fail("Destination must not be the treasury or the asset issuer");

    // The memo carries the job reference plus the first 8 chars of the idempotency key (built by the
    // orchestrator, safe charset, 28 bytes max). The duplicate search below matches on it.
    const memoText = (req.memo && /^[A-Za-z0-9 ._:-]{1,28}$/.test(req.memo) ? req.memo : req.idempotencyKey.slice(0, 28)).slice(0, 28);
    const amount = minorToDecimal(req.amountMinor, 7); // exact 7-decimal string, no float
    return this.serialize(() => this.send(req, destination, memoText, amount));
  }

  /** PYUSD held by the treasury account. Stellar pays in USD-pegged PYUSD, so only USD is answered. */
  async balance(currency: string): Promise<RailBalance | null> {
    if (currency !== "USD") return null;
    try {
      const account = await this.server.loadAccount(this.treasury.publicKey());
      const line = account.balances.find((b) => "asset_code" in b && b.asset_code === this.asset.getCode() && "asset_issuer" in b && b.asset_issuer === this.asset.getIssuer());
      if (!line) return { availableMinor: 0, currency, source: "provider" };
      return { availableMinor: Math.round(Number(line.balance) * 100), currency, source: "provider" };
    } catch {
      return null;
    }
  }

  private async send(req: ExecutionRequest, destination: string, memoText: string, amount: string): Promise<ExecutionResult> {
    let hash: string | null = null;
    try {
      // Load first, then look for a prior payment (see the class comment).
      const account = await this.server.loadAccount(this.treasury.publicKey());
      const prior = await this.findPriorPayment(memoText, destination, amount);
      if (prior) {
        return { status: "confirmed", externalId: prior, externalStatus: "success (already submitted)", explorerUrl: this.explorer(prior), ...this.figures(req, null), raw: { reusedExisting: true, hash: prior } };
      }
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.passphrase })
        .addOperation(Operation.payment({ destination, asset: this.asset, amount }))
        .addMemo(Memo.text(memoText))
        .setTimeout(60)
        .build();
      tx.sign(this.treasury);
      hash = Buffer.from(tx.hash()).toString("hex");
      req.beforeSubmit?.({ externalId: hash }); // persisted by the engine before the network sees it
      const result = await this.server.submitTransaction(tx);
      const feeStroops = await this.feeCharged(result.hash);
      return { status: "confirmed", externalId: result.hash, externalStatus: "success", explorerUrl: this.explorer(result.hash), ...this.figures(req, feeStroops), raw: { hash: result.hash, ledger: result.ledger, successful: result.successful } };
    } catch (e) {
      const err = e as { response?: { data?: { extras?: { result_codes?: unknown } } }; message?: string };
      const codes = err.response?.data?.extras?.result_codes;
      // Horizon answered with result codes: the network looked at the transaction and rejected it.
      // Nothing moved (tx_bad_seq, tx_too_late, op_no_trust and the like), so a retry is safe.
      if (codes) return fail(`Stellar rejected: ${JSON.stringify(codes)}`, err.response?.data ?? null);
      // Anything else (timeout, 5xx, dropped connection, history unreadable) is ambiguous.
      return { status: "unknown", externalId: hash, externalStatus: hash ? "submitted, outcome unknown" : null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: err.response?.data ?? null, errorMessage: `Stellar outcome unknown: ${err.message ?? "no answer"}${hash ? `. Look up tx ${hash}.` : ""}` };
    }
  }

  /** A transaction belongs to an attempt when its memo carries the first 8 characters of the attempt's key (see execute). */
  async externalIdMatchesKey(externalId: string, key: string): Promise<boolean | null> {
    try {
      const tx = await this.server.transactions().transaction(externalId).call();
      return tx.memo_type === "text" && typeof tx.memo === "string" && tx.memo.includes(key.slice(0, 8)) && tx.successful === true;
    } catch (e) {
      return /not ?found|404/i.test(String((e as Error).message ?? e)) ? false : null;
    }
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    try {
      const tx = await this.server.transactions().transaction(externalId).call();
      return { status: tx.successful ? "confirmed" : "failed", externalStatus: tx.successful ? "success" : "failed", explorerUrl: this.explorer(externalId), raw: { hash: tx.hash, ledger: tx.ledger_attr, memo: tx.memo } };
    } catch {
      return { status: "pending", externalStatus: "not found yet", explorerUrl: this.explorer(externalId), raw: null };
    }
  }

  /**
   * What actually happened on the ledger: PYUSD sent, network fee in XLM. The
   * modelled recipient-currency figure is deliberately not recorded here.
   */
  private figures(req: ExecutionRequest, feeStroops: string | null): Pick<ExecutionResult, "feeMinor" | "receivedMinor" | "receivedCurrency" | "fxRate" | "note"> {
    const q = quoteStellar(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    const fee = feeStroops ? `Network fee ${feeStroops} stroops (${(Number(feeStroops) / 1e7).toFixed(7)} XLM), not converted to USD.` : "Network fee not recorded.";
    const modelled = q.available && q.modelled ? ` PHP/${q.receiveCurrency} delivery through the anchor is modelled, not executed: Checkrail Pay sent PYUSD on Stellar only.` : "";
    return { feeMinor: 0, receivedMinor: req.amountMinor, receivedCurrency: "PYUSD", fxRate: "1", note: `${fee}${modelled}` };
  }

  private async feeCharged(hash: string): Promise<string | null> {
    try {
      const t = await this.server.transactions().transaction(hash).call();
      return String(t.fee_charged);
    } catch {
      return null;
    }
  }

  /**
   * Where the PYUSD goes. Testnet: the vendor's wallet. Production bank payout:
   * the anchor's SEP-31 receiving account. The anchor path is a Human Gate
   * (sending-anchor agreement with PeraHub) and is not implemented yet.
   */
  private resolveDestination(vendor: VendorPayoutProfile): string | null {
    return vendor.stellarAccount ?? null;
  }

  /**
   * Search the treasury's history for a successful payment with this memo that
   * also matches destination, asset and amount. Pages back up to HISTORY_MAX_PAGES
   * pages or HISTORY_MAX_AGE_MS. Throws if Horizon cannot be read: the caller must
   * not send when it cannot rule out a duplicate.
   */
  private async findPriorPayment(memoText: string, destination: string, amount: string): Promise<string | null> {
    let page = await this.server.transactions().forAccount(this.treasury.publicKey()).order("desc").limit(HISTORY_PAGE).call();
    const oldest = Date.now() - HISTORY_MAX_AGE_MS;
    for (let n = 0; n < HISTORY_MAX_PAGES; n++) {
      for (const t of page.records) {
        if (t.memo_type === "text" && t.memo === memoText && t.successful) {
          const ops = await t.operations();
          const ok = (ops.records as unknown as OpRecord[]).some(
            (op) => op.type === "payment" && op.to === destination && op.asset_code === this.cfg.pyusdCode && op.asset_issuer === this.cfg.pyusdIssuer && op.amount === amount
          );
          if (ok) return t.hash;
        }
      }
      const last = page.records[page.records.length - 1];
      if (page.records.length < HISTORY_PAGE || !last || Date.parse(last.created_at) < oldest) break;
      page = await page.next();
    }
    return null;
  }

  /** Run submissions one at a time so two payments never build from the same sequence number. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private explorer(hash: string): string {
    return `https://stellar.expert/explorer/${this.mode === "live" ? "public" : "testnet"}/tx/${hash}`;
  }
}

function fail(message: string, raw: unknown = null): ExecutionResult {
  return { status: "failed", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw, errorMessage: message };
}
