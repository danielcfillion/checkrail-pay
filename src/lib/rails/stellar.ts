import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ExecutionRequest, ExecutionResult, PaymentRail, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { config } from "../config";
import { quoteStellar } from "./quoteModel";

/**
 * Live Stellar adapter (testnet or public, chosen by STELLAR_NETWORK).
 *
 * Money path. Review every change here by hand.
 *
 * Execution sends PYUSD from the treasury account to the destination with the
 * obligation reference as the transaction memo. On testnet the destination is
 * the vendor's Stellar account (the demo recipient). In production the
 * destination for a bank payout is the anchor's SEP-31 receiving account and
 * the memo is the anchor-issued transaction id; that path is stubbed behind
 * `resolveDestination` so adding the anchor does not touch the signing code.
 *
 * Idempotency: the idempotency key is embedded in the memo (first 28 bytes),
 * and before submitting we query the treasury's recent payments for a matching
 * memo so a retried execute() cannot pay twice.
 */
export class StellarRail implements PaymentRail {
  readonly rail = "stellar" as const;
  readonly mode: "testnet" | "live";
  private readonly server: Horizon.Server;
  private readonly passphrase: string;
  private readonly treasury: Keypair;
  private readonly asset: Asset;

  constructor(private readonly cfg = config.rails.stellar) {
    this.mode = cfg.network === "public" ? "live" : "testnet";
    this.passphrase = this.mode === "live" ? Networks.PUBLIC : Networks.TESTNET;
    this.server = new Horizon.Server(cfg.horizonUrl);
    if (!cfg.treasurySecret) throw new Error("StellarRail requires STELLAR_TREASURY_SECRET");
    this.treasury = Keypair.fromSecret(cfg.treasurySecret);
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
    const destination = this.resolveDestination(req.vendor);
    if (!destination) return fail("Vendor has no Stellar destination (wallet or anchor) on file");

    const memoText = req.idempotencyKey.slice(0, 28); // Memo.text max 28 bytes
    const q = quoteStellar(req.vendor, req.amountMinor, req.currency, "US");

    // Idempotency guard: has this memo already been paid from the treasury?
    const prior = await this.findPriorPayment(memoText);
    if (prior) {
      return { status: "confirmed", externalId: prior, externalStatus: "success (already submitted)", explorerUrl: this.explorer(prior), feeMinor: q.feeMinor, receivedMinor: q.receiveAmountMinor, receivedCurrency: q.receiveCurrency, fxRate: q.fxRate, raw: { reusedExisting: true, hash: prior } };
    }

    try {
      const account = await this.server.loadAccount(this.treasury.publicKey());
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.passphrase })
        .addOperation(
          Operation.payment({
            destination,
            asset: this.asset,
            amount: (req.amountMinor / 100).toFixed(7),
          })
        )
        .addMemo(Memo.text(memoText))
        .setTimeout(60)
        .build();
      tx.sign(this.treasury);
      const result = await this.server.submitTransaction(tx);
      const hash = result.hash;
      return {
        status: "confirmed",
        externalId: hash,
        externalStatus: "success",
        explorerUrl: this.explorer(hash),
        feeMinor: q.feeMinor,
        receivedMinor: q.receiveAmountMinor,
        receivedCurrency: q.receiveCurrency,
        fxRate: q.fxRate,
        raw: { hash, ledger: result.ledger, successful: result.successful },
      };
    } catch (e) {
      const err = e as { response?: { data?: { extras?: { result_codes?: unknown } } }; message?: string };
      const codes = err.response?.data?.extras?.result_codes;
      return fail(codes ? `Stellar rejected: ${JSON.stringify(codes)}` : err.message ?? "Stellar submission failed", err.response?.data ?? null);
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
   * Where the PYUSD goes. Testnet: the vendor's wallet. Production bank payout:
   * the anchor's SEP-31 receiving account. The anchor path is a Human Gate
   * (sending-anchor agreement with PeraHub) and is not implemented yet.
   */
  private resolveDestination(vendor: VendorPayoutProfile): string | null {
    return vendor.stellarAccount ?? null;
  }

  private async findPriorPayment(memoText: string): Promise<string | null> {
    try {
      const page = await this.server.transactions().forAccount(this.treasury.publicKey()).order("desc").limit(50).call();
      const hit = page.records.find((t) => t.memo_type === "text" && t.memo === memoText && t.successful);
      return hit?.hash ?? null;
    } catch {
      return null; // if Horizon is unreachable we fall through and let submission fail loudly
    }
  }

  private explorer(hash: string): string {
    return `https://stellar.expert/explorer/${this.mode === "live" ? "public" : "testnet"}/tx/${hash}`;
  }
}

function fail(message: string, raw: unknown = null): ExecutionResult {
  return { status: "failed", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw, errorMessage: message };
}
