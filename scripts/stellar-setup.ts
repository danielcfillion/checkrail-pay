import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * One-time Stellar testnet setup for live mode. Run from a machine with
 * internet access:  npx tsx scripts/stellar-setup.ts
 *
 * Creates a treasury account and a demo recipient account, funds both with
 * test XLM from Friendbot, adds a PYUSD trustline to both, and prints the
 * values to put in .env. Test PYUSD itself comes from a faucet (see README).
 * The only secret printed is the treasury secret, once, because .env needs it.
 * The demo recipient's secret is never printed or stored: the recipient only
 * has to receive, and a secret nobody needs is a secret that cannot leak.
 */
const HORIZON = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const PYUSD_ISSUER = process.env.STELLAR_PYUSD_ISSUER ?? "GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G";
const PYUSD = new Asset("PYUSD", PYUSD_ISSUER);

async function fundWithFriendbot(publicKey: string): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!r.ok) throw new Error(`Friendbot failed for ${publicKey}: HTTP ${r.status}`);
}

async function addTrustline(server: Horizon.Server, kp: Keypair): Promise<string> {
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: PYUSD }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return res.hash;
}

async function main() {
  const server = new Horizon.Server(HORIZON);
  const treasury = Keypair.random();
  const recipient = Keypair.random();
  console.log("Funding treasury and demo recipient with Friendbot...");
  await fundWithFriendbot(treasury.publicKey());
  await fundWithFriendbot(recipient.publicKey());
  console.log("Adding PYUSD trustlines...");
  console.log("  treasury  trustline tx " + (await addTrustline(server, treasury)));
  console.log("  recipient trustline tx " + (await addTrustline(server, recipient)));

  console.log("\nPut these in .env:");
  console.log(`RAIL_MODE=live`);
  console.log(`STELLAR_NETWORK=testnet`);
  console.log(`STELLAR_TREASURY_SECRET=${treasury.secret()}`);
  console.log(`STELLAR_PYUSD_ISSUER=${PYUSD_ISSUER}`);
  console.log(`\nTreasury public key (fund this with test PYUSD from a faucet): ${treasury.publicKey()}`);
  console.log(`Demo recipient public key (put in .env as DEMO_STELLAR_RECIPIENT, then npm run db:seed): ${recipient.publicKey()}`);
  console.log(`\nExplorer: https://stellar.expert/explorer/testnet/account/${treasury.publicKey()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
