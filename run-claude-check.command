#!/bin/bash
# Checkrail Pay: reseed and run the replay with the Claude agent live. Output is written to run-claude-check.log.
cd "$(dirname "$0")"
exec > >(tee run-claude-check.log) 2>&1
echo "== $(date) =="
echo "== seed =="; npm run db:seed 2>&1 | tail -8
echo "== replay (Claude agent live, PayPal sandbox) =="; npm run demo:replay 2>&1 | tail -40
echo "== who read each request =="
node -e "const D=require('better-sqlite3');const d=new D('./data/checkrail-pay.sqlite',{readonly:true});for(const r of d.prepare(\"select actor, count(*) n from audit_entries where action='ai.interpreted' group by actor\").all())console.log(r.actor, r.n)"
echo "== done =="
