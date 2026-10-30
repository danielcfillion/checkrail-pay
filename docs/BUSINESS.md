# Checkrail Pay: the business on two pages

Draft of 29 Oct 2026, built from the round 1 business review. Figures marked "estimate" or "draft" are not yet tested with customers.

## Positioning

**Checks every supplier payment before money moves.**

A pre-payment control layer for supplier requests that arrive without a purchase order, checked against operational evidence (job sheets, departures, rate cards) and paid from the customer's own accounts.

## Who pays

**First segment: inbound tour operators in Hanoi** running northern loop departures (Ha Giang, Cao Bang, Sapa, Ha Long), roughly 20 to 200 departures a month, paying 30 to 150 freelance guides, easy riders, drivers and homestays, mostly from Zalo requests.

Why them first:
- The pain is concrete: no purchase orders, evidence is a departure manifest or a job sheet, requests arrive in chat.
- The founder runs tour operations in Northern Vietnam, so the workflow is known first hand, and operators share many of the same suppliers.
- Vietnam has 4,652 licensed international travel businesses as of July 2026 ([Viet Nam News](https://vietnamnews.vn/life-style/1797262/international-tour-operator-growth-signals-increased-travel-demand.html)).
- The PayPal and Wise use case is real for **foreign-registered operators** (like the demo company, a US LLC) paying Vietnamese and Filipino contractors from a USD treasury. Vietnamese-registered operators pay local suppliers in VND by bank file.

Wedge size (estimate): about 15,000 inbound operators across Vietnam, Thailand, the Philippines and Indonesia (the multiplier beyond Vietnam is an assumption), at about USD 950 a year, is about USD 14M a year. A good software business, not venture scale on its own. The expansion is any services SME that pays many informal suppliers against operational evidence: event agencies, fit-out subcontracting, logistics brokers, F&B groups, clinics paying locum staff.

## Competitors

| Player | What overlaps | Source |
|---|---|---|
| BILL | 498,000 businesses, AI agents since Oct 2025, USD 49 to 89 per user per month | [PYMNTS](https://www.pymnts.com/?p=3458854), [Corpay](https://www.corpay.com/resources/blog/bill-com-pricing) |
| Ramp | Agents for AP: coding, approval context, fraud and vendor-change flags | [PYMNTS](https://www.pymnts.com/?p=3107741) |
| Brex | AI invoice capture, duplicate flagging, payments in 50+ countries | [Brex](https://www.brex.com/solutions/payables) |
| Melio in Xero | Bill pay inside Xero US, with the JAX agent | [Open Banking Expo](https://www.openbankingexpo.com/news/xero-introduces-online-bill-payments-for-us-small-businesses/) |
| Tipalti | Global payables, from USD 99 a month, often USD 1,500 to 5,000 in practice | [ERP Research](https://www.erpresearch.com/erp-add-ons/ap-automation/tipalti/pricing) |
| Airwallex | AgentOS: AI intent, deterministic money movement, human confirmation on payouts | [The Asian Banker](https://www.theasianbanker.com/updates-and-articles/can-airwallex-bridge-the-gap-between-ai-intent-and-financial-execution) |
| Payoneer | APAC revenue up 21%, credited to SE Asia digital entrepreneurs | [Payoneer Q3 2025](https://www.lionheartv.net/2025/11/payoneer-reports-third-quarter-2025-financial-results) |
| Xelix | USD 160M Series B, agentic AP error and fraud detection, enterprise | [PYMNTS](https://www.pymnts.com/?p=2844900) |
| AppZen | Eight AP agents for vendor email | [SiliconANGLE](https://siliconangle.com/?p=739614) |
| Clerked (ex Mod AI) | AP agents from capture to payment, mid-market | [YC](https://www.ycombinator.com/companies/mod-ai) |
| Digits | AI Bill Pay for US small businesses | [PYMNTS](https://www.pymnts.com/?p=1936806) |
| Peakflo | Built for Singapore and SE Asian finance teams: AI AP assistant, invoice OCR, a WhatsApp vendor portal for invoice submission, approval routing and automated disbursement. Its duplicate detection rides on purchase-order matching. | [Peakflo AP](https://peakflo.co/accounts-payable), [Peakflo SE Asia](https://peakflo.co/blog/ai-agent-automation-singapore-finance-psg-2026) |

## What is different, and what is not

**Different (claim only these):**
1. Evidence is operational, not a purchase order: job sheet, departure manifest and rate card against what was asked. This is the real slot. Peakflo, the closest regional player, matches against purchase orders; a supplier request with no PO has nothing to fail against there.
2. Non-custodial and bring-your-own-rail: payments go from the customer's PayPal, Wise or bank file.

**Weaker than first written (say them carefully):**
3. Informal intake. Peakflo already takes invoices through a WhatsApp vendor portal. Checkrail's version would be Zalo and email, which do not exist yet; today requests are pasted or uploaded. Claim it only once Zalo intake ships, and only as "Zalo", not as "chat intake nobody else has".
4. SE Asia focus. Peakflo already serves Singapore and SE Asian finance teams. The narrower true claim is very small Vietnamese service operators (20 to 200 departures a month) that pay freelancers without POs.

**Not different (do not lead with these):** AI reading invoices, duplicate detection, deterministic policy around an AI, approval limits and maker-checker, and multi-rail routing. Our own benchmark says Wise is cheaper than both PayPal and Stellar, so routing on cost is not a selling point.

## Pricing (draft, founder to confirm)

| Plan | Who | Price | Includes |
|---|---|---|---|
| Review | Owner trying it | Free | 30 checked payments a month, Review everything only, one rail |
| Operator | SME paying 30 to 300 suppliers a month | USD 79 a month (VND list price about 1,990,000) | 300 checked payments, Assist and Autopilot with caps, rate cards and departures, all rails, 3 approvers; USD 0.20 per extra checked payment |
| Practice | Accounting firm or bookkeeper | USD 35 per client business a month, minimum 5 clients | Operator features per client, one practice login, MISA or Xero export |

Rules behind it:
- Charge per checked payment, never a percentage of money moved. That keeps Checkrail software, not a money transmitter.
- Value test: blocking one wrong USD 40 to 80 request a month pays for the Operator plan.
- Vietnam list price to be set from pilot conversations; the reference point is MISA AMIS online accounting at VND 2.95 to 8.15 million ([MISA AMIS pricing](https://amis.misa.vn/20355/bao-gia-phan-mem-ke-toan-online-misa-amis/)), so the Operator plan in VND must be justified by errors blocked, not by comparison with the ledger. Test VND 490,000, 990,000 and 1,990,000 a month in the first pilot conversations (F6).
- Measure Claude cost per checked payment on real requests before publishing. Above about USD 0.05, revisit the extra-payment price.
- Tour variant to test in the first pilots: USD 1 per departure closed, minimum USD 49 a month. Keep one of the two.

## First 10 customers

1. **Three to five tour operators running northern loop departures.** Their last 90 days of supplier payments re-checked in Review mode, then one month live in Review mode. Operators share suppliers, so a homestay that invoices three operators gets one onboarding link.
2. **Two Hanoi service-accounting firms** that keep books for small travel companies. They work in MISA. Offer a wholesale price.
3. **Two foreign-owned operators** registered abroad and operating in Vietnam, with the real PayPal and Wise use case.

PayPal and SCF give credibility and at most a showcase listing. Neither is a revenue channel.

## Checkrail never touches money

```
  Business's own account                         Supplier
  (PayPal / Wise / bank)  ======= funds =======>  (PayPal / bank / wallet)
          ^
          | payment instruction, sent with the
          | business's own API credentials
          | (or a bank file the business uploads)
  +---------------+
  | Checkrail Pay |   reads, checks, decides, records
  +---------------+   holds no funds, no pooled account, no sweep
```

On Stellar the same holds: the business funds its own spend-policy contract, stays its owner and can withdraw at any time.

## Regulatory checklist

Not legal advice. Each line is a question to close before real customers.

- [ ] **US, FinCEN.** Keep the software-provider position: FinCEN excludes suppliers of software tools from the money-transmitter definition, and an intermediary without independent control of funds is not transmitting ([Katten on FinCEN 2019](https://katten.com/fincen-publishes-guidance-pertaining-to-certain-business-models-involving-convertible-virtual-currencies)). Never hold a pooled treasury, never sweep, never charge a percentage of payout.
- [ ] **Canada, RPAA.** Ask a Canadian payments lawyer: "Does initiating payouts from the customer's own PayPal or Wise account through their API credentials make us a payment service provider under the Retail Payment Activities Act, given the corporation has a place of business in Canada?" The Act covers a PSP with a place of business in Canada whatever the customers' location ([McMillan](https://mcmillan.ca/?p=10536)), and the Bank of Canada's case scenarios treat software that adds payment initiation as a distinct paid service as a PSP ([Bank of Canada](https://www.bankofcanada.ca/2023/12/case-scenarios-about-payment-accounting-software-and-invoice-payment-services/)). In the same hour, ask where the corporation is tax-resident when its sole director lives in Vietnam.
- [ ] **Vietnam, Circular 32.** Payments between residents inside Vietnam are in VND unless an exception applies ([Mondaq summary, 2014; confirm it is current](https://www.mondaq.com/financial-services/314242/circular-32-provides-guidance-on-the-restrictions-on-the-use-of-foreign-currencies-in-vietnam)). A Vietnamese-registered operator pays local suppliers in VND by bank file; the USD PayPal story belongs to foreign payers.
- [ ] **Vietnam, PDPL (Law 91/2025).** In effect since 1 Jan 2026. Cross-border transfers of personal data need a transfer impact assessment, and fines reach 5% of prior-year revenue ([Tilleke & Gibbins](https://tilleke.com/insights/vietnams-new-personal-data-protection-law-a-closer-look)). Decree 356/2025: supplier bank details are sensitive data; file the cross-border transfer impact assessment within 60 days of the first transfer ([Vietnam Briefing](https://www.vietnam-briefing.com/news/vietnam-personal-data-protection-regulation-decree-356.html)). Foreign entities processing Vietnamese citizens' data are in scope, and the small-enterprise grace period does not apply to anyone directly processing sensitive data. Checkrail stores supplier bank account numbers, so draft the dossier before the first Vietnamese pilot.
- [ ] **Vietnam, crypto pilot.** Crypto assets are recognised under a five-year pilot that settles in VND through licensed providers only ([Allen & Gledhill](https://www.allenandgledhill.com/perspectives/articles/31332/vnkh-vietnam-establishes-digital-technology-framework-and-launches-crypto-asset-market-pilot-program)). No Stellar route for Vietnamese suppliers; the app refuses it.
- [ ] **Entity.** No legal entity owns the code, domain or PayPal app yet. Recommendation: a British Columbia corporation (no director residency requirement), not a federal CBCA one, which needs a Canada-resident director ([CBCA s.2(1)](https://laws-lois.justice.gc.ca/eng/acts/c-44/page-1.html), [Clark Wilson](https://www.cwilson.com/doing-business-in-canada-advantages-of-incorporating-in-british-columbia/)). See F4 in `docs/FOUNDER_DECISIONS.md`.

## Moat plan

The safety architecture (model reads, deterministic policy decides, APIs move money, people confirm exceptions) is now the industry default. The moats worth building, in order:

1. **A regional supplier graph.** The same homestays, drivers and guides serve many operators. Verified payout details, typical rates per route and season, and duplicate signals across operators get better with every operator added. Target: 20 operators on one graph with a measurable lift in catch rate.
2. **Vertical evidence connectors:** departure manifests, booking engines, rate cards and each major Vietnamese bank's bulk template.
3. **Local intake:** a Zalo Official Account, which US players will not build.
4. **On-chain spend policy on Stellar**, weaker than first thought: OpenZeppelin's Spending Limit policy and REAPP (SCF #43) already occupy it. The useful part is the cancel window, the owner pause and the anchor receiver-id binding built on those, if SCF funds it.

## Sources

All from the round 1 business review (29 Oct 2026): BILL ([PYMNTS](https://www.pymnts.com/?p=3458854), [Corpay](https://www.corpay.com/resources/blog/bill-com-pricing)), Ramp ([PYMNTS](https://www.pymnts.com/?p=3107741)), Brex ([Brex](https://www.brex.com/solutions/payables)), Xero and Melio ([Open Banking Expo](https://www.openbankingexpo.com/news/xero-introduces-online-bill-payments-for-us-small-businesses/)), Tipalti ([ERP Research](https://www.erpresearch.com/erp-add-ons/ap-automation/tipalti/pricing)), Airwallex ([The Asian Banker](https://www.theasianbanker.com/updates-and-articles/can-airwallex-bridge-the-gap-between-ai-intent-and-financial-execution)), Payoneer ([LionhearTV](https://www.lionheartv.net/2025/11/payoneer-reports-third-quarter-2025-financial-results)), Xelix ([PYMNTS](https://www.pymnts.com/?p=2844900)), AppZen ([SiliconANGLE](https://siliconangle.com/?p=739614)), Clerked ([YC](https://www.ycombinator.com/companies/mod-ai)), Digits ([PYMNTS](https://www.pymnts.com/?p=1936806)), Viet Nam News on licensed travel businesses, Katten on FinCEN, Bank of Canada RPAA scenarios, Mondaq on Circular 32, Tilleke & Gibbins on the PDPL, Allen & Gledhill on Vietnam's crypto pilot. MISA's claim of over 250,000 businesses: [MISA](https://hokinhdoanh.misa.vn/?p=243819). Added from the round 2 business review (29 Oct 2026): Peakflo ([AP](https://peakflo.co/accounts-payable), [SE Asia](https://peakflo.co/blog/ai-agent-automation-singapore-finance-psg-2026)), MISA AMIS pricing ([MISA](https://amis.misa.vn/20355/bao-gia-phan-mem-ke-toan-online-misa-amis/)), Decree 356/2025 ([Vietnam Briefing](https://www.vietnam-briefing.com/news/vietnam-personal-data-protection-regulation-decree-356.html)), the CBCA residency rule ([Justice Laws](https://laws-lois.justice.gc.ca/eng/acts/c-44/page-1.html), [Clark Wilson](https://www.cwilson.com/doing-business-in-canada-advantages-of-incorporating-in-british-columbia/)) and RPAA scope ([McMillan](https://mcmillan.ca/?p=10536)).
