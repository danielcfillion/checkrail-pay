# Checkrail Pay API

A small REST API for other software: a booking system sends its departures, and an ERP or accounting tool sends payment requests and reads back what happened to them. Every request still goes through Checkrail's checks before money moves. Nothing in this API can approve, release or send a payment, or read or change a supplier's payout details.

The full description is `docs/openapi.yaml` (OpenAPI 3.1), served as JSON at `GET /api/v1/openapi.json`. Paste that URL into Postman, Insomnia or any OpenAPI tool.

## Keys

Keys live in the server's environment, never in the app:

    CHECKRAIL_API_KEYS=bokun:<secret>:departures:write,erp:<secret>:requests:write+requests:read+vendors:read

One entry per system, comma separated, `name:secret:scopes`, scopes joined with `+`. Names are lowercase letters, digits and dashes. Secrets are at least 24 characters (32 where real money can move), with no spaces, colons or commas. Generate one with:

    node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

If the setting is malformed, every API call is refused with 401 until it is fixed; the caller is not told why. Settings, System, API keys says the setting is malformed (so does the server log), and otherwise lists each key's name, scopes and when it was last used; it never shows a secret.

| Scope | What it allows |
| --- | --- |
| `departures:write` | Send departures (the booking feed) and read them back. |
| `requests:write` | Put payment requests in the inbox. |
| `requests:attest` | What this key attaches counts as the business's own records. Needs `requests:write`. |
| `requests:read` | Read back the requests this key made. A key never sees another key's requests. |
| `vendors:read` | Look up suppliers: id, name, verified or not. |

### Trust: what `requests:attest` changes

Without it, the evidence a key sends is its own say-so, like a record a clerk types in. Policy treats it that way: a person approves the payment unless the business's own records (a departure with a rate card, a job sheet or booking from its own systems) already support it.

With it, the key is treated as a system of record, like an agent key with `attest`: what it attaches counts as the business's own records, so a request that matches them can be approved by policy and, on Autopilot, scheduled inside the owner's caps. Give it only to the system that is the record (the booking platform itself, the ERP that holds the purchase orders), never to a tool that relays what someone told it. Even then, the autonomy setting, the per-payment and daily caps, the cancel window and the re-check at release all still apply, and the key still cannot approve or send.

`departures:write` deserves the same care: a departure, with the supplier's rate card, sets what a job should cost and counts as support. Give it only to the booking system.

## Calls

Every call sends the key as a bearer token. Bodies are JSON. Examples use placeholder keys.

### Send departures (the booking feed)

    curl -sS https://<your-checkrail>/api/v1/departures \
      -H "Authorization: Bearer <bookings-key>" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: feed-2026-11-01-0900" \
      -d '{"departures": [{
            "external_id": "bokun-88231",
            "code": "HG-4D-1104",
            "start_date": "2026-11-04",
            "end_date": "2026-11-07",
            "guests": 12,
            "services": [
              {"vendor": "Phuong Transport", "unit": "vehicle_day", "quantity": 4},
              {"vendor_id": "ven_linh", "unit": "guest_night", "quantity": 24}
            ]}]}'

Departures are matched by `external_id`: sending one again replaces its dates, guests and services. A departure already on file with the same code (typed in, or from a manifest import) is taken over the first time the feed sends it. Up to 200 departures a call; one invalid departure and nothing is saved. Units: `day`, `vehicle_day`, `guest_night`, `room_night`, `guest`, `trip`. Afterwards Checkrail checks again the requests waiting on the suppliers the call touched, as it does after a manifest import.

Read them back, optionally from a start date:

    curl -sS "https://<your-checkrail>/api/v1/departures?since=2026-11-01" -H "Authorization: Bearer <bookings-key>"

### Send a payment request

    curl -sS https://<your-checkrail>/api/v1/requests \
      -H "Authorization: Bearer <erp-key>" \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: erp-bill-104233" \
      -d '{"payee": "Phuong Transport",
           "amount": "800.00",
           "currency": "USD",
           "reference": "HG-4D-1104",
           "description": "Van and driver, 4 vehicle-days",
           "evidence": [{"kind": "purchase_order", "label": "PO 104233", "amount": "800", "reference": "HG-4D-1104",
                         "excerpt": "Phuong Transport, HG-4D-1104, 4 vehicle-days at USD 200"}]}'

`Idempotency-Key` is required here: a retry with the same key and body gets the first answer back (with `Idempotency-Replayed: true`) and never makes a second request; the same key with a different body is refused. Use `vendor_id` instead of `payee` if you have it. Attach files as `documents` (at most 3, each at most 2 MB, base64):

    "documents": [{"name": "invoice.pdf", "content_type": "application/pdf", "kind": "invoice", "data": "<base64>"}]

A document is read the way a clerk's upload is; a supplier's own invoice still goes to a person. Fields the endpoint does not know (`approve`, `paypal_email`, anything else) are refused, not ignored.

The answer (201) is the request after the checks. `status` is one of `blocked`, `waiting_for_evidence`, `waiting_for_approval`, `scheduled` (Autopilot sends it at `releases_at` unless a person cancels), `approved`, `sending`, `paid`, `returned`, `cancelled`, `failed`, `disputed`. `verdict` is what the rules say (`pay`, `hold` or `block`), `reasons` says why in plain words and `rules_failed` gives the rule ids. Payout details are never included.

### Read requests back

    curl -sS https://<your-checkrail>/api/v1/requests/<id> -H "Authorization: Bearer <erp-key>"
    curl -sS "https://<your-checkrail>/api/v1/requests?reference=HG-4D-1104" -H "Authorization: Bearer <erp-key>"

`settlement` shows whether it was sent, over which `rail`, the provider's id (such as a PayPal payout batch), when it settled, what was sent and the fee.

### Look up suppliers

    curl -sS "https://<your-checkrail>/api/v1/vendors?q=phuong" -H "Authorization: Bearer <erp-key>"

Returns `id`, `name`, `role`, `country`, `status` and `verified` (whether a person verified the payout details).

## Errors

Always `{"error": {"code": "...", "message": "..."}}`; a validation error adds `details`, one entry per field:

    {"error": {"code": "validation_failed", "message": "departures[0].start_date: must be a date, YYYY-MM-DD",
               "details": [{"field": "departures[0].start_date", "message": "must be a date, YYYY-MM-DD"}]}}

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `idempotency_key_required`, `invalid_idempotency_key` |
| 401 | `unauthorized` |
| 403 | `insufficient_scope`, `cross_origin` |
| 404 | `not_found` |
| 409 | `idempotency_in_progress`, `departure_conflict` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `validation_failed`, `idempotency_conflict`, `document_refused`, `request_refused` |
| 429 | `rate_limited` (per key, 120 a minute unless `CHECKRAIL_API_RATE_LIMIT` says otherwise), `too_many_bad_keys` (wrong keys only, per address; a valid key is never locked out) |
| 500 | `internal_error`: Checkrail could not finish the call and nothing was paid. Retry with the same `Idempotency-Key`; if the request was already created, the retry returns it instead of making a second one. |
| 503 | `not_set_up` (no business is set up yet) |

## Audit

Everything a key changes is in the audit log under `api:<key name>`: departures as `departures.upserted`, requests as created by that integration, and any re-check a departure triggered. The request page shows the integration as who asked.
