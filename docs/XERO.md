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
5. **Use the demo company first.** In Xero, open the organisation menu and choose the Demo Company. It is free, full of sample data and resets itself, so nothing real is touched while you try it.
6. **Connect from Settings.** As the owner, open Settings, System, and press **Connect to Xero**. Sign in at Xero, pick the Demo Company and allow access. You come back to Settings with the organisation's name on the Xero card.
7. **Check the accounts.** Checkrail reads the chart of accounts and fills first guesses. Choose:
   - **Supplier bills**: used when a bill's own account (310, 320, 400, 429 or the vendor's code) is not in this chart.
   - **PayPal clearing**, **Stellar treasury** and **Wise and bank file**: the bank accounts each rail pays from. Add bank accounts in Xero first if the chart has none for them.
   - **Payment fees**: usually 404 Bank Fees.
   - **Tax rate on bills**: usually Tax Exempt or No Tax.

   Press Save accounts.
8. **Send something.** Approve a request, or settle one, and wait for the next heartbeat or press **Push to Xero**. In Xero, look under Business, Bills to pay for the bill (Checkrail Pay in the reference), and under the bank account for the payment and the fee.

## What goes to Xero, and when

| Checkrail | Xero | When |
| --- | --- | --- |
| Vendor | Contact, found by name, else created | with its first bill |
| Bill (one per invoice; a deposit and its balance are one bill) | Bill (ACCPAY, Authorised), with the tax-withheld line and a Departure tracking option when Xero has that option | when the request is approved |
| Credit note | Credit note (ACCPAYCREDIT) | when it is recorded |
| Settled payment | Payment against the bill, from the rail's bank account, for the amount sent | when the payment settles |
| Fee (PayPal, Wise, bank file) | Spend money on the same bank account, to the fee account | with the payment |

A Stellar fee is taken out of the amount in transit, so no separate fee is booked.

## When something cannot be sent

The Xero card lists it in plain words ("Your Xero organisation does not have VND turned on...", "Xero said: ..."). It is tried again after a short wait (1, 2, 4 ... up to 60 minutes), or at once with Push to Xero. Each bill, payment and fee is created once: Xero's id is stored, a write carries an Idempotency-Key, and a write whose answer was lost is looked up in Xero before it is tried again.

Xero allows 60 calls a minute per organisation (1,000 a day on a new app's starter tier). Checkrail stays under the minute limit on its own and, if Xero answers 429, waits for the Retry-After it gives.

## Disconnecting

Disconnect Xero on the card removes the connection at Xero and deletes the tokens here. What is already in Xero stays there. If Xero cannot be reached, the tokens are still deleted; remove Checkrail Pay under Connected apps in Xero as well.
