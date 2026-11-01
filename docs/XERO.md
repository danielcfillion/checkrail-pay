# Connecting Xero

Checkrail Pay can send each approved bill to Xero, and its payment and fee when the payment settles, instead of you importing the bills file and the settlement CSV. The two files stay on the Accounting page as the fallback and carry the same records.

Nothing about a payment waits for Xero. The push runs beside the payment path, on the autopilot heartbeat (every 15 seconds by default), on `POST /api/autopilot/tick`, and when someone presses Push to Xero.

## Steps

1. **Create a Xero developer app.** Sign in at developer.xero.com, open My Apps and choose New app. Pick **Web app** (the Auth Code grant). Any company URL will do for a test.
2. **Add the redirect URI.** It must match exactly:
   - local: `http://localhost:3000/api/xero/callback`
   - hosted: `<your site>/api/xero/callback`, where the site is `NEXT_PUBLIC_SITE_URL` if set, else Render's `RENDER_EXTERNAL_URL`. The Xero card on Settings shows the exact value this server uses.
3. **Copy the client id and generate a client secret.** Put them in `.env` (or the host's secret settings), never in chat or a commit:

        ACCOUNTING_DESTINATION=xero
        XERO_CLIENT_ID=...
        XERO_CLIENT_SECRET=...
        CHECKRAIL_DATA_KEY=<32 bytes, base64>   # encrypts the Xero tokens at rest; required on any production server

   Restart the server.
4. **Scopes.** Nothing to set in the Xero app: Checkrail asks for them when you connect. Xero moved web apps to granular scopes in March 2026, so the default request is

        openid profile email offline_access accounting.invoices accounting.payments accounting.banktransactions accounting.contacts accounting.settings.read

   An older app that still has the broad `accounting.transactions` scope can set `XERO_SCOPES` to its own list.
5. **Use the US Demo Company.** In Xero, open the organisation menu and choose the Demo Company, and pick the **US** version so its base currency is USD like the demo's payments. It is free, full of sample data and resets itself, so nothing real is touched while you try it. Other currencies (VND, PHP) need multi-currency turned on in that organisation.
6. **Connect from Settings.** As the owner, open Settings, System, and press **Connect to Xero**. Sign in at Xero, pick the Demo Company and allow access. You come back to Settings with the organisation's name on the Xero card.
7. **Check the accounts.** Checkrail reads the chart of accounts and fills first guesses. Choose:
   - **Supplier bills**: used when a bill's own account (310, 320, 400, 429 or the vendor's code) is not in this chart.
   - **PayPal clearing**, **Stellar treasury** and **Wise and bank file**: the bank accounts each rail pays from. Each must be in the currency of the payments it carries. Add bank accounts in Xero first if the chart has none for them.
   - **Payment fees**: usually 404 Bank Fees.
   - **Tax rate on bills** (required): usually Tax Exempt. With a rate that carries tax, the amounts are sent tax inclusive, so a bill's total is still what is paid.

   Press Save accounts.
8. **Send something.** Approve a request, or settle one, and wait for the next heartbeat or press **Push to Xero**. In Xero, look under Business, Bills to pay for the bill (Checkrail Pay in the reference), and under the bank account for the payment and the fee.

## What goes to Xero, and when

Only what is approved after you connect. Bills approved before that stay in the bills file and the settlement CSV, with their payments; the Xero card says how many. Reconnecting the same organisation keeps that starting point.

| Checkrail | Xero | When |
| --- | --- | --- |
| Vendor | Contact, found by exact name, else created | with its first bill |
| Bill (one per invoice; a deposit and its balance are one bill, with the tax withheld on every part) | Bill (ACCPAY, Authorised), with a Departure tracking option when Xero has that option | when the request is approved |
| Credit note | Credit note (ACCPAYCREDIT) | when it is recorded |
| Settled payment | Payment against that vendor's bill, from the rail's bank account, for the amount sent | when the payment settles |
| Fee (PayPal, Wise, bank file) | Spend money on the same bank account, to the fee account, referenced `fee <invoice> <payment id>` | with the payment |

A Stellar fee is taken out of the amount in transit, so no separate fee is booked.

## How it avoids sending twice

- Each bill, payment and fee sent is recorded here with Xero's id, keyed on the contact and invoice number (bills) or on the payment and the provider's transaction id (payments and fees). A recorded one is not sent again.
- Before a bill is created, Xero is searched for a bill with the same number for the same contact; if there is one, it is used. A bill for a different contact with the same number is never used.
- Before a payment is created, the bill's payments in Xero are read: one with the same reference is used; failing that, if Xero holds more payments of that amount on the bill than Checkrail has recorded, one of them is taken as this payment (and its fee is not booked again). This is what keeps a demo reset from paying the same demo bill twice.
- Each create call carries an Idempotency-Key, and the record is marked "sending" with that key in the database before the call. If the answer is lost, or the server stops before saving it, the next pass looks the item up in Xero before creating it. Xero keeps an idempotency key for only six minutes, so this look-up is what covers a longer gap.

These cover the cases above. Something deleted or edited by hand in Xero is not detected.

## When something cannot be sent

The Xero card lists it in plain words ("Your Xero organisation does not have VND turned on...", "Xero said: ..."). It is tried again after a short wait (1, 2, 4 ... up to 60 minutes), or at once with Push to Xero. If the chart of accounts cannot be read, the push waits the same way and the card says so.

Xero allows 60 calls a minute per organisation (1,000 a day on a new app's starter tier). Checkrail counts its calls in the database, stops at 55 a minute, and if Xero answers 429 waits for the Retry-After it gives. Only one push runs at a time, also across server processes. Each call to Xero times out after 20 seconds.

## Disconnecting

Disconnect Xero on the card removes the connection at Xero, revokes the refresh token and deletes the tokens here. What is already in Xero stays there. If Xero cannot be reached, or the sign-in had already expired, the tokens are still deleted and the card tells you to remove Checkrail Pay under Connected apps in Xero as well.
