# Connecting Xero

Checkrail Pay can send each approved bill to Xero, and its payment and fee when the payment settles, instead of you importing the bills file and entering payments from the settlement records. The files stay on the Accounting page as the fallback and carry the same records.

## The files on the Accounting page: which one to import

| File | For | What it is |
| --- | --- | --- |
| **Bills CSV** (Export new bills for Xero) | **Importing** into Xero: Business, Bills to pay, Import | One bill per invoice in Xero's "Import bills" template, at the invoice's gross amount. Each press holds only bills not exported before. |
| **Bookkeeper pack** (.xlsx) | **Reading**, for the accountant | A formatted workbook: a cover sheet (business, period, what each sheet is, totals, how to use it with Xero), the bills, the payments (real dates, amounts as numbers in their currency, account code and name, who paid the fee, what the recipient received and at what rate, the explorer link) and fees by rail and month. Never imported. |
| **Settlement records CSV** | **Reading**, for matching payments from the bank feed | One row per settled payment. Never imported. |

Only the bills CSV is imported. Payments match from the bank feed: each payment is one bank line for its `netPaid`.

**Export history.** Every bills export is recorded: when, by whom, how many bills and the file itself. The Accounting page shows the last one ("32 bills exported 2 Nov, 17:40") and every earlier one, each with Download again. Download again gives the identical file, byte for byte, and marks nothing. Import each file once: importing the same file again creates its bills a second time.

**Settlement records CSV columns, changed 3 Nov 2026.** `accountCode` is the bare code the bills file carries ("310"), and a new `accountName` holds its name ("Cost of Goods Sold: Contract labour"); before, `accountCode` held both. A new `feePaidBy` says who bore the fee: `business` (paid on top, inside `netPaid`) on every rail now; `recipient` only on Stellar rows from before 3 Nov 2026, when the fee came out of the amount. For a simulated Stellar payment the `explorerUrl` column says `simulated, not on chain`.

**Default accounts, changed 3 Nov 2026.** Guides 310 Contract labour; transport and vehicle or motorbike rental (the driver role) 320 Transport and vehicle hire; homestays and hotels 325 Accommodation (was 320); creators 400; others 429; cash advances 620. A vendor's own code always wins.

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
        CHECKRAIL_DATA_KEY=<32 bytes, base64>   # encrypts the Xero tokens at rest; required for Xero everywhere, demo included

   Restart the server.
4. **Scopes.** Nothing to set in the Xero app: Checkrail asks for them when you connect. Xero moved web apps to granular scopes in March 2026, so the default request is

        openid profile email offline_access accounting.invoices accounting.payments accounting.banktransactions accounting.contacts accounting.settings.read

   An older app that still has the broad `accounting.transactions` scope can set `XERO_SCOPES` to its own list.
5. **Use the US Demo Company.** In Xero, open the organisation menu and choose the Demo Company, and pick the **US** version so its base currency is USD like the demo's payments. It is free, full of sample data and resets itself, so nothing real is touched while you try it. Other currencies (VND, PHP) need multi-currency turned on in that organisation.
6. **Connect from Settings.** As the owner, open Settings, System, and press **Connect to Xero**. Sign in at Xero, pick the Demo Company and allow access. You come back to Settings with the organisation's name on the Xero card. Only the organisation picked in that sign-in is used; if Xero does not say which one it was, the connection is refused and you connect again.
7. **Check the accounts.** Checkrail reads the chart of accounts and fills first guesses. Choose:
   - **Supplier bills**: used when a bill's own account (310, 320, 325, 400, 429 or the vendor's code) is not in this chart.
   - **PayPal clearing**, **Stellar treasury** and **Wise and bank file**: the bank accounts each rail pays from. Each must be in the currency of the payments it carries. Add bank accounts in Xero first if the chart has none for them.
   - **Payment fees**: usually 404 Bank Fees.
   - **Tax withheld**: the liability account for tax kept back from a vendor (US backup withholding, Vietnamese PIT, Philippine EWT), usually 825. Payments must be enabled on it: in Xero, open Accounting, Chart of accounts, click the account, tick **Enable payments to this account**, save, then press Read accounts again here. Needed only once a payment withholds tax.
   - **Tax rate on bills** (required): usually Tax Exempt. With a rate that carries tax, the amounts are sent tax inclusive, so a bill's total is still what is paid.

   Press Save accounts.
8. **Send something.** Approve a request, or settle one, and wait for the next heartbeat or press **Push to Xero**. In Xero, look under Business, Bills to pay for the bill (Checkrail Pay in the reference), and under the bank account for the payment and the fee.

## What goes to Xero, and when

Only what is approved after you first connect. A bill whose first part was approved before that stays in the bills file and the settlement CSV, with all its payments (a deposit before and a balance after included); the Xero card says how many. Disconnecting and reconnecting the same organisation keeps that starting point and the record of what was sent, so payments for bills already sent still go.

| Checkrail | Xero | When |
| --- | --- | --- |
| Vendor | Contact, found by Xero's contact search and an exact name check (archived contacts passed over), else created | with its first bill |
| Bill (one per invoice; a deposit and its balance are one bill) | Bill (ACCPAY, Authorised) at the invoice's gross amount, with a Departure tracking option when Xero has that option | when the request is approved |
| Credit note | Credit note (ACCPAYCREDIT) | when it is recorded |
| Settled payment | Payment against that vendor's bill, from the rail's bank account, for the amount sent | when the payment settles |
| Tax kept back on that payment | A second payment against the same bill, from the tax withheld account, for what that payment really withheld (reference `<rail>:<transaction id>:wh`) | with the payment |
| Credit note applied to a bill | Allocation of the credit note to the bill | once both are in Xero |
| Fee (every rail) | Spend money on the same bank account, to the fee account, referenced `fee <invoice> <obligation id>` | with the payment |

The business pays the fee on every rail, and the supplier receives the full bill. On Stellar the amount sent is grossed up so the anchor's fee does not come out of the bill; that fee is booked like PayPal's. A Stellar payment settled before 3 Nov 2026, when the fee came out of the amount, books no fee spend.

### Tax withheld

The bill is the invoice's gross amount. Each part paid clears its share in two payments: what was sent from the rail's bank account, and what was kept back from the tax withheld account. The bill therefore clears exactly, whatever each part really withheld: rounding on a split invoice, a W-9 filed between deposit and balance, or a per-payment threshold. The liability then sits on the tax withheld account until it is paid to the tax office.

The bills file does the same: bills are at gross with no withholding line. The settlement CSV's last column, `xeroPayment`, says what to do with each row:

- `xero:<payment id>`: the live push has put all of it in Xero (payment, withheld part and fee). Do not enter it.
- `xero:sending`: the live push owns it and will send it (it is waiting, or retrying after a failure shown on the Xero card). Do not enter it either.
- `xero:returned`: the payout came back, and everything the live push sent for it was removed in Xero (or nothing was sent). Nothing to enter.
- `returned:reverse-by-hand`: the payout came back and its bill is in the files: if you entered this payment in Xero, reverse it there by hand.
- A payout that came back whose payment Xero would not delete keeps its `xero:<payment id>`; the Xero card asks a person to reverse it.
- blank: its bill came from the file (or Xero is not connected). Record the payment from the bank feed and the `withheldAmount` as a second payment on the bill from the tax withheld account (in Xero: on the bill, Make a payment, Paid from: the tax withheld account).

### With Xero connected, the bills file leaves out the live bills

While the destination is xero and Xero is connected, Export new bills on the Accounting page leaves out the bills the live push owns (approved after connecting), so a bill is never both imported and sent.

### Changes after a bill went to Xero

- A request cancelled or rejected after its bill went: the bill is voided in Xero if nothing is paid or credited on it. If something is, the card asks a person to sort it out in Xero. If only part of a bill was cancelled and the rest is paid, the card says by how much the bill is still open in Xero, to adjust or credit there.
- A payout that came back: its payment (and withheld part) is deleted in Xero, so paying the vendor again fits the bill; anything of that payout not yet sent is closed and never sent. Its fee stays booked, and the card says what to check: PayPal returns its fee with a returned payout, so remove or reverse that fee spend in Xero; for Wise and the bank file the fee was spent, so change nothing unless the provider refunded it. A payment already deleted in Xero is taken as done. If Xero will not delete it (a reconciled payment, for one), the card says it needs a person in Xero and it is not retried.
- An approved request whose amount or reference is amended: once it is agreed again, its bill is updated in Xero while nothing is paid on it; otherwise the card asks for the same change by hand.
- A credit note applied to a bill that is in the files stays in the files too, and the card asks for the credit to be applied in Xero by hand.
- Each of these keeps its own error and waits (1, 2, 4 ... up to 60 minutes) before another try, like everything else, so one stuck item never holds up the rest.

## How it avoids sending twice

- Each create call carries an Idempotency-Key, and the record is marked "sending" with that key in the database before the call. If the answer is lost, or the server stops before saving it, the next pass looks the item up in Xero before creating it. Xero keeps an idempotency key for only six minutes, so this look-up is what covers a longer gap.
- Each bill, payment and fee sent is recorded here with Xero's id, keyed on the contact and invoice number (bills) or on the payment and the provider's transaction id (payments and fees). A recorded one is not sent again.
- Before a bill is created, Xero is searched for a bill with the same number for the same contact; if there is one, it is used. A bill for a different contact with the same number is never used.
- Before a payment is created, Xero's payments are searched for its reference (the rail and the provider's transaction id); one found is used. As a last resort, if the bill in Xero holds more payments of that amount than Checkrail has recorded, one of them is taken as this payment and its fee is not booked again; the card and the Accounting page count these as skipped fees. This is what keeps a demo reset from paying the same demo bill twice.
- A success from Xero whose answer cannot be read is treated like a lost answer.
- One rule for anything that may already be in Xero (a lost answer, or a server that stopped mid-send): at the start of the next pass it is looked up by what it was sent as, before anything else is decided about it. Found, it is taken on under its record, so a later cancel voids it, an amendment updates it, and a returned payout removes it. Not found, it is cleared and goes again only if still due. A row left "sending" by a stopped server shows on the card until then.
- A payment waits while its bill's amendment has not reached Xero yet, rather than being paid against the old bill.
- Matching a payment by amount (the demo-reset case) never takes a Xero payment any record already holds, and waits while another payment on the same bill is still being looked up. Look-ups run every pass, whatever the record's own send wait.
- Look-ups take at most 15 of a pass's 40 calls, longest waiting first, so sending always has room. A look-up that fails (an error, not "not found") waits its own backoff before the next try.
- When a look-up finds nothing and the request has since been cancelled or its payout came back, it is looked up once more; if still nothing, the card asks a person to check that bill in Xero.

These cover the cases above. Something deleted or edited by hand in Xero is not detected.

### Switching to another organisation

Connecting a different Xero organisation starts the live push there from that moment. Bills the previous organisation received from the live push are not copied over: their exported marks are cleared, so they appear again in the bills file (Export new bills) for you to import into the new organisation, and their settled payments go back to waiting, so Export CSV carries them too.

## When something cannot be sent

The Xero card lists it in plain words ("Your Xero organisation does not have VND turned on...", "Xero said: ..."). It is tried again after a short wait (1, 2, 4 ... up to 60 minutes), or at once with Push to Xero. If the chart of accounts cannot be read, the push waits the same way and the card says so.

Xero allows 60 calls a minute per organisation (1,000 a day on a new app's starter tier). Checkrail counts its calls in the database, stops at 55 a minute, and if Xero answers 429 waits for the Retry-After it gives. Only one push runs at a time, also across server processes. Each call to Xero times out after 20 seconds.

## Disconnecting

Disconnect Xero on the card removes the connection at Xero, revokes the refresh token and deletes the tokens here. What is already in Xero stays there, and Checkrail keeps its record of what it sent. If Xero cannot be reached, or the sign-in had already expired, the tokens are still deleted and the card tells you to remove Checkrail Pay under Connected apps in Xero as well.
