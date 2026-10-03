# Dueline Corridor Benchmark

Research date: 2026-10-03. Sender: US business. Rails compared: PayPal Payouts, Stellar PYUSD via anchor, Wise Business (reference). Every figure is sourced; items marked "estimate" explain the basis. Items marked "could not verify" were not confirmable from a primary source during this pass.

## 1. Corridor selection

Method: fetched each anchor's `stellar.toml` and `/info` endpoints where reachable, plus SDF, anchor and press sources. The SDF anchor directory ([resources.stellar.org/anchors](https://resources.stellar.org/anchors)) could not be fetched (robots.txt), so this is a per-anchor verification, not a full directory sweep. SDF itself notes the directory "is not comprehensive" ([source](https://stellar.org/blog/developers/anchor-directory-guide-finding-interoperable-asset-issuers-on-off-ramps-stellar)).

| Corridor | Live anchor with local bank/wallet payout? | Asset | Notes |
|---|---|---|---|
| US -> Philippines (PHP) | Yes. PeraHub (PETNET Inc., Aboitiz group): `stellar.perahub.com.ph`, SEP-31 receiving anchor, SEP-10 auth, SEP-12 KYC server declared. Also MoneyGram Ramps (SEP-24, cash pickup only). | USDC only (issuer GA5ZSE...KZVN). No PYUSD. | PeraHub `/sep31/info`: USDC receive enabled, min 0.1, max 1,000 USDC, fee 5 USDC fixed + 1% ([source](https://stellar.perahub.com.ph/sep31/info), [toml](https://stellar.perahub.com.ph/.well-known/stellar.toml)). PeraHub payout methods: bank transfer, cash pickup, mobile wallets across 3,000+ locations ([Aboitiz](https://aboitiz.com/pera-hub-leverages-on-stellar-network-to-make-remittances-affordable-and-accessible)). SEP-31 requires a sending-anchor agreement; a third-party tracker found SEP-12 returning 403 to unregistered callers as of 2026-09-23 ([source](https://github.com/ezedike-evan/stellar-intel/issues/1303)). Arf + Tempo also run a live EU -> PH USDC corridor via an unnamed local payout partner ([SDF](https://stellar.org/blog/arf-and-tempo-launch-new-stellar-based-payments-from-europe-to-the-philippines)). |
| US -> Indonesia (IDR) | Could not verify any live Stellar IDR anchor. | n/a | No SEP endpoint found. Treat as unavailable. |
| US -> Mexico (MXN) | Yes, Bitso: SDF names Bitso as a Stellar USDC on/off ramp for MXN serving "more than 2 million users" ([SDF](https://www.stellar.org/blog/introducing-stellar-ramps-access-stellars-on-off-ramps-with-a-single-integration)); Bitso publishes "Stellar Receiving Anchor Services" docs ([docs](https://docs.bitso.com/mm-xb/docs/bitsos-stellar-receiving-anchor-services)). | USDC | Bitso's anchor docs are behind a navigation shell that could not be parsed; fees, KYC fields and limits could not be verified. Bitso is a B2B SEP-31 counterparty, so a commercial agreement is required. |
| US -> Kenya (KES) | Partial. Link (LINK.IO LTD, `ngnc.online`) declares KESC in its toml but the SEP-24 `/info` returns no KESC deposit/withdraw config ([info](https://anchor.ngnc.online/sep24/info)). ClickPesa is live for TZS to bank and mobile money (Tanzania, Kenya, Rwanda footprint) ([SDF](https://stellar.org/blog/making-cross-border-b2b-payments-easier-in-east-africa-with-clickpesa?locale=es)) but its toml could not be fetched. MoneyGram cash pickup is available. | USDC (ClickPesa), own tokens (Link) | KES bank payout via a verified SEP endpoint: could not verify. |
| US -> Nigeria (NGN) | Partial. Link anchors NGNC with SEP-24 withdraw enabled (min 10,000, max 5,000,000 NGN) ([info](https://anchor.ngnc.online/sep24/info)), but the asset is NGNC not USDC, so a DEX swap is needed and the toml shows no fee schedule. Yellow Card supports USDC on Stellar across 20 African countries but does not publish SEP endpoints ([SDF press](https://stellar.org/press/yellow-card-introduces-usdc-on-stellar)). Cowrie: could not verify current status. | NGNC, USDC via Yellow Card app | Workable but not clean for a demo. |
| US -> Argentina / Brazil | Anclap (Grupo Anchor S.A.) is live with SEP-6 and SEP-24 for ARS and PEN ([toml](https://api.anclap.com/.well-known/stellar.toml)) but only for its own ARS/PEN tokens, not USDC ([verification](https://github.com/ezedike-evan/stellar-intel/issues/1273)). Brazil BRL via a verified SEP anchor: could not verify (Settle Network/Latamex status unconfirmed; Vortex by SatoshiPay announced PIX offramp, not confirmed as a SEP anchor). | ARS/PEN tokens | Requires USDC -> ARS DEX path. |
| US -> Vietnam (VND) | No. Confirmed none. | n/a | Vietnam's Law 71/2025/QH15 (effective 2026-01-01) recognises crypto as digital assets "not as a mean of payment"; Resolution 05/2025 pilots up to five VND-denominated exchanges; no licensed VND stablecoin off-ramp exists ([PwC](https://www.pwc.com/vn/en/publications/2025/vietnam-cryptocurrencies.pdf)). |

Recommendation: US -> Philippines (PHP) as the first corridor.

Reasons: (1) the only corridor in the set with a verified, machine-readable SEP-31 anchor paying out to local banks and wallets (PeraHub) plus a second live USDC off-ramp (MoneyGram Ramps, cash); (2) PayPal supports "send, receive, and withdraw in local currency" for PH recipients, so the PayPal comparison is like-for-like ([PayPal country table](https://developer.paypal.com/docs/payouts/standard/reference/country-feature/)); (3) the Philippines was in MoneyGram's first-wave Stellar launch in 2022 ([Fintech News PH](https://fintechnews.ph/56101/remittance/moneygram-launches-global-crypto-to-cash-service-in-the-philippines/)) and GCash now lists USDC, so recipient familiarity is high ([Bitwage](https://bitwage.com/en-us/blog/state-of-stablecoins-in-philippines-september-2025)). Mexico via Bitso is the best second corridor once a Bitso agreement exists.

Caveats: PeraHub caps a single SEP-31 transaction at 1,000 USDC and charges 5 USDC fixed, which is heavy under about $200. KYC for recipients runs through SEP-12 with fields the anchor defines (relationship, purpose, peso_amount, partner_name are required transaction fields). Settlement time is not published; Stellar ledger close is about 5 seconds ([Kraken](https://blog.kraken.com/product/new-features/pyusd-deposits-and-withdrawals-now-available-on-stellar)), and PH bank credit over InstaPay is real time, PESONet same day ([TransFi](https://www.transfi.com/blog/how-to-convert-usdc-to-php-gcash-maya-and-bank-cash-out-options-compared)). Estimate: 1 to 30 minutes end to end.

## 2. PYUSD on Stellar

- Live on mainnet since 2025-09-18, issued by Paxos Trust Company ([SDF press](https://stellar.org/press/paypal-pyusd-is-now-available-on-stellar)).
- Mainnet issuer: `GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5` ([PayPal Developer](https://developer.paypal.com/community/blog/pyusd-on-stellar); [Paxos toml](https://token-metadata.paxos.com/.well-known/stellar.toml)). Horizon on 2026-10-03: 10,159 authorized accounts, about 3.6M PYUSD in accounts plus about 8.76M in contracts; flags: auth_required false, auth_revocable true, clawback enabled ([Horizon](https://horizon.stellar.org/assets?asset_code=PYUSD&asset_issuer=GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5)).
- Testnet issuer: `GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G`; "Test PYUSD is available for free using the Google Cloud Web3 faucet or the Paxos faucet" ([PayPal Developer](https://developer.paypal.com/community/blog/pyusd-on-stellar)). Horizon testnet shows 1,395 holders and about 2.1M test PYUSD ([Horizon testnet](https://horizon-testnet.stellar.org/assets?asset_code=PYUSD&asset_issuer=GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G)). Note: the Paxos sandbox docs page lists only EVM and Solana testnets ([Paxos](https://docs.sandbox.paxos.com/guides/stablecoin/pyusd/testnet)), so rely on the PayPal Developer post and the Google Cloud faucet (100 test PYUSD per Google account per day on other chains; Stellar limit could not verify) ([PayPal Developer](https://developer.paypal.com/community/blog/testnet-pyusd)).
- Wallet and exchange support: Bitcoin.com, Chipper Cash, Decaf, Arculus, Meru, CiNKO, COCA, Lobstr ([SDF press](https://stellar.org/press/paypal-pyusd-is-now-available-on-stellar)); Kraken deposits and withdrawals since 2026-07-28 ([Kraken](https://blog.kraken.com/product/new-features/pyusd-deposits-and-withdrawals-now-available-on-stellar)).
- Anchor support: every anchor verified above (PeraHub, MoneyGram Ramps, Anclap, Link) lists USDC or its own fiat token, not PYUSD. MoneyGram's developer docs mention USDC only ([MoneyGram](https://developer.moneygram.com/moneygram-developer/docs/moneygram-ramps)). Conclusion: Dueline must do a PYUSD -> USDC conversion on Stellar before hitting the anchor, via a path payment or DEX trade. Horizon returned no PYUSD/USDC AMM pool with reserves on 2026-10-03 ([Horizon](https://horizon.stellar.org/liquidity_pools?reserves=PYUSD%3AGDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5%2CUSDC%3AGA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)); order-book depth could not be fetched. Estimate: budget a 0.1% swap slippage, and prefer a Soroban DEX or Paxos/Kraken redemption path in production. stellar.expert indexes PYUSD at $0.9994 ([stellar.expert API](https://api.stellar.expert/explorer/public/asset/PYUSD-GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5)).

## 3. Fee benchmark: US -> Philippines

Mid-market: 1 USD = 62.607736 PHP, open.er-api.com, 2026-10-03 00:02 UTC ([source](https://open.er-api.com/v6/latest/USD)). Wise's live quote the same day was 62.7746 ([Wise](https://wise.com/us/send-money/send-money-to-philippines)); the ER-API figure is used throughout.

Assumptions and sources:
- PayPal Payouts international: 2% of amount, cap $20 USD ([PayPal merchant fees](https://www.paypal.com/us/webapps/mpp/merchant-fees)). Sender pays. Recipient receives USD in a PH PayPal account.
- PayPal PH conversion when withdrawing a USD balance to a PHP bank: Asia Pacific "balance transfers and other conversions" 3.0% above base rate; 4.0% applies to personal payments ([PayPal PH fees](https://www.paypal.com/ph/digital-wallet/paypal-consumer-fees)). Business payouts fall under 3.0%; Wise's guide quotes 4% for the receiving-payment case ([Wise](https://wise.com/ph/blog/receive-money-paypal-philippines)). Modelled at 3.0%, flag 4.0% as upside risk.
- PayPal PH bank withdrawal: PHP 50 if under PHP 7,000, otherwise free ([PayPal PH fees](https://www.paypal.com/ph/digital-wallet/paypal-consumer-fees)). Standard bank transfer 1 to 5 days, instant option in minutes ([Wise](https://wise.com/ph/blog/paypal-to-bank-account-ph)).
- Stellar: network fee 100 stroops base, p50 100 stroops = 0.00001 XLM, effectively $0 ([Horizon fee_stats](https://horizon.stellar.org/fee_stats)). PYUSD -> USDC swap: estimate 0.1%. PeraHub: 5 USDC + 1% ([PeraHub](https://stellar.perahub.com.ph/sep31/info)). Anchor FX markup: not published; estimate 1.0% based on PH remittance norms and PeraHub's "low fees" positioning. Recipient bank fee: PHP 0 (InstaPay credit is paid by the sender-side partner; estimate).
- Wise: variable fee for USD -> PHP via bank debit; Wise quoted $2.99 total on $500 ([Wise](https://wise.com/us/send-money/send-money-to-philippines)). A third-party profile lists "$1.17 + 0.8%" for one Wise USD -> PHP route ([RemitAnalyst](https://remitanalyst.com/send-money-to-philippines-from-timor-leste/remit-profiles/transferwise/)); $1.50 at $100 and $5.50 at $1,000 are estimates interpolated from those two points. Wise uses the mid-market rate with no markup. 74% of transfers arrive in under 20 seconds.

| Amount | Rail | Sender fee | FX markup | Recipient-side fee | Est. recipient receives (PHP) | Settlement |
|---|---|---|---|---|---|---|
| $100 | PayPal Payouts | $2.00 (2%) | 3.0% | PHP 50 (under 7,000) | 100 x 62.6077 x 0.97 = 6,072.95; minus 50 = **6,022.95** | PayPal credit instant; bank 1 to 5 days (instant option available) |
| $100 | Stellar PYUSD -> PeraHub | $0.00001 XLM | 0.1% swap + 1.0% anchor FX (est.) | 5 USDC + 1% = $5.999 | 100 x 0.999 = 99.9 USDC; minus 5.999 = 93.901; x 62.6077 x 0.99 = **5,820.14** | 1 to 30 min (est.) |
| $100 | Wise Business | $1.50 (est.) | 0% | PHP 0 | 98.50 x 62.6077 = **6,166.86** | Seconds to 1 day |
| $500 | PayPal Payouts | $10.00 (2%) | 3.0% | PHP 0 | 500 x 62.6077 x 0.97 = **30,364.75** | as above |
| $500 | Stellar PYUSD -> PeraHub | ~$0 | 1.1% total (est.) | 5 + 1% = $9.995 | 499.5 minus 9.995 = 489.505; x 62.6077 x 0.99 = **30,340.33** | 1 to 30 min (est.) |
| $500 | Wise Business | $2.99 | 0% | PHP 0 | 497.01 x 62.6077 = **31,116.67** | Seconds to 1 day |
| $1,000 | PayPal Payouts | $20.00 (2%, hits cap) | 3.0% | PHP 0 | 1000 x 62.6077 x 0.97 = **60,729.50** | as above |
| $1,000 | Stellar PYUSD -> PeraHub | ~$0 | 1.1% total (est.) | 5 + 1% = $14.99 | 999 minus 14.99 = 984.01; x 62.6077 x 0.99 = **60,990.57** | 1 to 30 min (est.) |
| $1,000 | Wise Business | $5.50 (est.) | 0% | PHP 0 | 994.50 x 62.6077 = **62,263.39** | Seconds to 1 day |

Reading the table honestly: on published fees, Stellar via PeraHub only beats PayPal above roughly $500 and never beats Wise. Its advantage is speed and programmability, plus total sender cost (PayPal's $20 is borne by the sender and excluded from the recipient column). If the anchor FX markup is 0.5% rather than 1.0%, Stellar wins against PayPal at $500 too. Note that PeraHub's 1,000 USDC cap means $1,000 is the single-transaction ceiling.

## 4. PayPal Payouts availability

- Access: requires a PayPal Business account linked to a bank, then "request access to PayPal Payouts"; PayPal reviews before approval ([PayPal](https://www.paypal.com/us/business/operations/mass-payments); [Developer](https://developer.paypal.com/docs/payouts/standard/)).
- Sender countries: the country table lists sender capability per country; US is "fully localized"; Philippines, Indonesia, Vietnam, Kenya, Argentina, Brazil can send, receive and withdraw; Mexico is receive and withdraw only ([country table](https://developer.paypal.com/docs/payouts/standard/reference/country-feature/)). Nigeria receiving only became possible in 2026 via Paga ([Mobility NG](https://mobility.com.ng/can-nigerians-access-paypal-and-receive-funds/)). Reach: "over 156 countries in over 23 currencies" ([FAQ](https://developer.paypal.com/docs/payouts/standard/reference/faq)).
- Sandbox: available before approval; test error injection via item note values such as `ERRPYO002` ([Developer](https://developer.paypal.com/docs/payouts/standard/integrate-api/)).
- Fees (US sender): Payouts API domestic flat $0.25 per USD payout; web domestic 2% capped $1.00; international (web and API) 2% capped $20.00 USD; PayPal conversion rates apply when currencies differ ([PayPal](https://www.paypal.com/us/business/operations/mass-payments); [merchant fees](https://www.paypal.com/us/webapps/mpp/merchant-fees)). Recipients pay no payout fee.
- Limits: $20,000 per payment by default (new accounts), up to $60,000 for established accounts; 15,000 payments per API call; 400 POST requests per minute ([PayPal](https://www.paypal.com/us/business/operations/mass-payments); [API ref](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/); [Developer](https://developer.paypal.com/docs/payouts/standard/integrate-api/)).
- Delivery: existing PayPal account holders "get their payment instantly"; unclaimed payouts expire after 30 days ([Developer](https://developer.paypal.com/docs/payouts/standard/reference/payment-processing)).

## 5. Recommended mock parameters

```json
{
  "asOf": "2026-10-03",
  "corridors": {
    "US_PH": {
      "midRate": 62.607736,
      "midRateSource": "https://open.er-api.com/v6/latest/USD",
      "paypal": {
        "feePct": 2.0,
        "feeCapUsd": 20.0,
        "fxSpreadPct": 3.0,
        "withdrawalFeeLocal": 50,
        "withdrawalFeeLocalThreshold": 7000,
        "etaSeconds": 172800,
        "etaNote": "instant to PayPal balance; 1-5 days to PHP bank, instant option exists"
      },
      "stellar": {
        "asset": "PYUSD",
        "swapToUsdcPct": 0.1,
        "networkFeeUsd": 0.000001,
        "anchor": "PeraHub (PETNET Inc.)",
        "anchorFeePct": 1.0,
        "anchorFeeMinUsd": 5.0,
        "anchorMaxUsd": 1000,
        "fxSpreadPct": 1.0,
        "etaSeconds": 900
      },
      "wiseReference": {
        "feeFixedUsd": 1.17,
        "feePct": 0.8,
        "fxSpreadPct": 0.0,
        "etaSeconds": 60
      }
    },
    "US_US": {
      "midRate": 1.0,
      "paypal": {
        "feeFlatUsd": 0.25,
        "feePct": 0.0,
        "feeCapUsd": 0.25,
        "fxSpreadPct": 0.0,
        "withdrawalFeeLocal": 0,
        "etaSeconds": 60,
        "etaNote": "API flat rate; instant to existing PayPal account"
      },
      "stellar": {
        "asset": "PYUSD",
        "networkFeeUsd": 0.000001,
        "anchorFeePct": 0.0,
        "anchorFeeMinUsd": 0.0,
        "fxSpreadPct": 0.0,
        "etaSeconds": 10,
        "note": "PYUSD to PYUSD wallet; no anchor; off-ramp to US bank via PayPal/Paxos/Kraken not modelled"
      }
    }
  }
}
```

Flags for the critic: anchorFeeMinUsd is modelled as a fixed 5 USDC added to the 1% (PeraHub's schema is fee_fixed plus fee_percent, not a minimum); fxSpreadPct for the anchor and the Wise fixed fee tiers are estimates; PayPal 3.0% could be 4.0% depending on how PayPal classifies the balance conversion.
