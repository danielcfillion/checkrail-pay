# Dueline for the accounting ecosystem: Xero pitch

One page. For a Xero partnerships or app ecosystem conversation.

## What Dueline is

Dueline is an AI payables operations layer for small businesses that pay contractors and suppliers across borders. It reads payment requests in whatever form they arrive (invoice photo, job sheet, chat), checks them against evidence and payment history, blocks the ones that are wrong, pays the right ones over PayPal Payouts or Stellar PYUSD, and produces a reconciled bill, payment and fee record for every settlement.

## The problem your customers have

A Xero customer with overseas contractors (a tour operator, an agency with freelancers in the Philippines, a logistics firm with local drivers) runs payables in three places: a chat thread where requests arrive, a PayPal or bank tab where money leaves, and Xero where someone retypes what happened a week later. The bookkeeper spends hours matching payouts to bills, fees are posted as mystery differences, and duplicates and inflated invoices get through because nothing in the chain is checking.

## What Dueline writes into Xero

For every settled obligation, three things that reconcile to the cent:

- **Contact**: the vendor, created or matched by name, with country on the address.
- **Bill (ACCPAY)**: reference, bill date, description, gross amount and currency, account code.
- **Payment**: payment date, net paid, against the bank account for the rail (PayPal clearing or Stellar treasury).
- **Bank fee line**: the rail fee on a bank fees account, so gross, fee and net tie out.

The mapping is built and exercised by tests and the CSV exporter today. OAuth to a live tenant is the remaining step.

## Why this is good for Xero

- It removes the hardest manual reconciliation in the SME cross-border book: payouts to individuals by email or local bank account, with fees and FX.
- It brings stablecoin settlement into Xero as ordinary bills and payments, with the fee and FX visible, which is how an accountant can sign off on it. Nobody else is doing this for SMEs in a way bookkeepers will accept.
- The audit log behind every record (what was requested, what evidence was checked, which rule fired, who approved, which rail paid, with idempotency keys) is exactly what an advisor wants when a client asks "why did we pay this".
- The customer is already on Xero. Dueline makes Xero the system of record for the whole payment, not just the aftermath.

## What we would ask Xero for

1. **App marketplace listing** in bills and payments, once OAuth is live, with a listing review slot in the next available window.
2. **Co-marketing** around one story: how a small tour operator stopped paying duplicates and got its overseas payables reconciled daily. One case study, one webinar for advisors.
3. **Practice channel introduction**: a handful of accounting firms in Xero's partner programme serving travel, agency and field-service clients with overseas contractors, for a pilot of five to ten client businesses.
4. **A developer contact** for the payments-adjacent questions: bank account mapping for a stablecoin treasury, multi-currency bill handling when the payout currency differs from the bill currency.

## What we offer in return

Clean, reconciled data; an honest, published corridor benchmark that advisors can cite; and a product whose whole purpose is to make Xero the place where every supplier payment is already done.

Contact: Daniel Fillion, founder. Repository: github.com/<you>/dueline.
