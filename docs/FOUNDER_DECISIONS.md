# Founder decisions

Decisions only Daniel can make. Each has a recommendation and the reason. When one is made, write the answer and the date under it, then tell the builder lane.

| # | Decision | Recommendation | Why | By |
|---|---|---|---|---|
| F1 | Confirm the pricing draft | Accept the three plans in `docs/BUSINESS.md` (Review free, Operator USD 79 a month, Practice USD 35 per client a month), charged per checked payment | Devpost and the SCF application now show it as planned pricing. Judges score Potential Impact higher when the business model is visible. Per checked payment, never a percentage of money moved, keeps Checkrail on the software side of money-transmission rules. | Before Devpost (12 Nov) |
| F2 | Confirm Best Use of PayPal + AI as the lead prize | Yes. Then Best Demo Delivery, plus Best Use of AG Grid as the one sponsor prize (Render stays the host) | It is where the depth counts most: PayPal's own records decide a block (the app reads Transaction Search before any payment and cites the PayPal transaction id), Claude checks the same history, and Books reconciles from Transaction Search. AG Grid pays cash to five winners and has a judge on the panel; Render pays in credits. Agentic Commerce means consumer checkout at PayPal. | Before Devpost |
| F3 | SCF #46 go or no-go | Builder's recommendation for you to confirm (not a decision taken): "No-go for #46 (decided [date]): no open track fits, the primitive is already funded (REAPP, SCF #43) and available (OpenZeppelin Spending Limit policy), and there is no testnet release or traction. Apply to #47 on the Integration track, built on OpenZeppelin smart accounts, with pilots as traction." | See "SCF go or no-go" below. Deciding now frees your hours for the video. | Now (deadline for #46 is 8 Nov) |
| F4 | Form a corporation and assign the IP | Incorporate in British Columbia (no director residency requirement; a federal CBCA corporation needs a Canada-resident director). Own it 100%, sign an IP assignment from you to it, and move the domain, repo and PayPal app into it. In the lawyer hour, ask two questions: (1) does initiating payouts from a customer's own PayPal or Wise account through their API credentials make us a payment service provider under the RPAA, given the corporation has a place of business in Canada; (2) where is the corporation tax-resident when its sole director lives in Vietnam. | SCF needs KYB, live Payouts needs an approved business account, the ElevenLabs grant stalled on a registration number, and any buyer needs one clean owner. The Devpost rules leave IP with the entrant, so the assignment is clean. A CBCA corporation requires at least one resident Canadian director when there are fewer than four, and you live in Vietnam. | Before any live money |
| F5 | Run Loop Tours' last 90 days of supplier payments through Review mode | Export them, re-check them in Review mode, count duplicates, overcharges and mismatches, and sign off the numbers. Put the real numbers in the video's first 15 seconds and in Devpost | The single biggest lift for Potential Impact, and it starts customer zero. If the count is zero, that is crucial information too. | Before recording the video |
| F6 | Ask three operators for pilot letters | Three operators that share suppliers with Loop, or two operators and one Hanoi service-accounting firm. One paragraph each: "We will pilot Checkrail in Review mode in December at VND X a month." | The cheapest credibility available for both Devpost and SCF. | 12 Nov |
| F7 | Point checkrailpay.com at the landing page | Host `site/` (see `site/README.md`) and point the domain at it. Until it serves, docs say "coming soon" or omit it | The domain is owned but does not resolve, and a judge who types it sees nothing. | Before Devpost |
| F8 | Book one hour with a Canadian payments and tax lawyer | Ask the two questions in F4: RPAA status, and tax residency with a sole director in Vietnam | The RPAA covers a payment service provider with a place of business in Canada whatever the customers' location, and the Bank of Canada's case scenarios treat software that adds payment initiation as a paid service as a PSP. The answer decides whether the entity registers with the Bank of Canada before charging anyone. | Before incorporating if possible, and before the first paid pilot |
| F9 | Confirm the Devpost "Inspiration" bridge paragraph is true | Founder confirms this is true before submitting: "The demo company, Ridgeline Expeditions, is a US operator, because a US payer can pay Vietnamese and Filipino contractors in USD over PayPal. My own company pays most local suppliers in dong by bank transfer, which Checkrail covers with a bank file." Edit it in `docs/DEVPOST.md` if any part is not true, and check the sentence before it ("pays from a PayPal tab") the same way. | Judges read the founder story and then see a US demo company. The bridge sentence removes the switch, but only if it is accurate. | Before Devpost (12 Nov) |

## SCF go or no-go (moved here from the SCF application)

The builder's recommendation for F3. It is for the founder to confirm or overrule; nothing has been decided.

**Recommendation: no-go for #46, apply to #47.**

Why, from the round 2 business review (29 Oct 2026):
- **No open #46 track fits.** The RFP track has no open RFPs ("New Q4 RFPs are coming soon"). The Integration track is for teams with existing traction integrating a building block from the SCF Integration List, and is "not for net-new protocols".
- **The primitive exists.** REAPP was awarded USD 70K in SCF #43 for an on-chain mandate registry with budget caps and merchant restrictions for agent payments. OpenZeppelin's Stellar smart accounts ship a Spending Limit policy and an agent-wallet example. Policywright won USD 55K in SCF #44 for generating those policies.
- **No testnet release and no traction**, and traction must be verifiable in the submission.
- **About USD 27,000 of the USD 60,000 budget was not fundable** (security review, legal, pilot onboarding). These lines are now removed from `docs/SCF_APPLICATION.md`.

If you still want #46, the conditions from the earlier draft stand: before 6 Nov, (1) one real testnet payment released through the spend-policy contract from the app, with an explorer link in "What is built", and (2) the interest form submitted. Before submitting either round, check in the SCF handbook: the tranche structure, the team minimum, the track, and any jurisdiction restriction for an applicant based in Vietnam.

**The fundable shape for #47 (Integration track):**
- Checkrail Pay with Loop Tours and pilots as traction.
- Integrate OpenZeppelin smart accounts and their Spending Limit policy, plus a small custom policy for the cancel window and pause. Do not ship a bespoke contract.
- Pay Filipino suppliers through a listed anchor or wallet building block.
- A modest on-chain metric, for example USD 25,000 cumulative supplier payments released through policy-governed accounts over 60 days across three businesses.
- A budget of USD 25,000 to 50,000.
- Fix the allow-list for anchor payouts: bind the allowed payee to the anchor account plus the supplier's SEP-31 receiver id, or say plainly that on-chain allow-listing applies only to wallet-holding payees.

When you decide, write the answer and the date under F3.
