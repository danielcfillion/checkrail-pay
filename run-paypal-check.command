#!/bin/bash
# Checkrail Pay: reseed and run the live PayPal sandbox replay. Output is written to run-paypal-check.log.
cd "$(dirname "$0")"
exec > >(tee run-paypal-check.log) 2>&1
echo "== $(date) node $(node -v) =="
echo "== seed =="; npm run db:seed 2>&1 | tail -8
echo "== replay (live PayPal sandbox, Stellar mock) =="; npm run demo:replay 2>&1 | tail -60
echo "== done =="
