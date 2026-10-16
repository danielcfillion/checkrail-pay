#!/usr/bin/env python3
"""
Take the README screenshots from a running Checkrail Pay server.

    npm run db:seed && npm run dev          # in one terminal
    python3 scripts/screenshots.py          # in another; writes docs/screenshots/*.png

Run it with RAIL_MODE=live AI_MODE=live set on the server for the submission set, so the
sidebar footer reads "PayPal sandbox, agent Claude" and the obligation pages show Claude's tool calls.
Needs: pip install playwright && python3 -m playwright install chromium
Env: BASE_URL (default http://localhost:3000), CHECKRAIL_BASIC_AUTH (user:pass) if the server has it.
"""
import os, sys, json, sqlite3, base64
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = Path(__file__).resolve().parent.parent / "docs" / "screenshots"
DB = Path(os.environ.get("DATABASE_PATH", "./data/checkrail-pay.sqlite"))

def story_ids():
    con = sqlite3.connect(DB)
    rows = con.execute("select id, source_ref, state from obligations").fetchall()
    con.close()
    by_ref = {r[1]: r[0] for r in rows}
    return {
        "mismatch": by_ref.get("INV-2026-0152"),
        "duplicate": by_ref.get("JOB-HG4D-0914"),
        "paid": by_ref.get("JOB-HG4D-0921"),
        "ana": by_ref.get("JOB-PAL3D-0927"),
    }

def main():
    ids = story_ids()
    headers = {}
    auth = os.environ.get("CHECKRAIL_BASIC_AUTH")
    if auth:
        headers["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
    shots = [
        ("overview.png", "/", 1440, 1000, "light"),
        ("overview-dark.png", "/", 1440, 1000, "dark"),
        ("overview-mobile.png", "/", 390, 844, "light"),
        ("blocked-mismatch.png", f"/obligations/{ids['mismatch']}", 1440, 1300, "light"),
        ("blocked-mismatch-dark.png", f"/obligations/{ids['mismatch']}", 1440, 1300, "dark"),
        ("blocked-duplicate.png", f"/obligations/{ids['duplicate']}", 1440, 1300, "light"),
        ("blocked-duplicate-dark.png", f"/obligations/{ids['duplicate']}", 1440, 1300, "dark"),
        ("paid-paypal.png", f"/obligations/{ids['paid']}", 1440, 1300, "light"),
        ("awaiting-stellar.png", f"/obligations/{ids['ana']}", 1440, 1300, "light"),
        ("awaiting-stellar-dark.png", f"/obligations/{ids['ana']}", 1440, 1300, "dark"),
        ("daily-close.png", "/close", 1440, 1100, "light"),
        ("daily-close-dark.png", "/close", 1440, 1100, "dark"),
        ("autonomy-settings.png", "/settings", 1440, 1100, "light"),
        ("demo.png", "/demo", 1440, 1000, "light"),
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, path, w, h, scheme in shots:
            if "None" in path:
                print(f"skip {name}: obligation not found (seed first)"); continue
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, extra_http_headers=headers, device_scale_factor=2)
            page = ctx.new_page()
            page.goto(BASE + path, wait_until="networkidle")
            page.wait_for_timeout(600)
            page.screenshot(path=str(OUT / name), full_page=False)
            ctx.close()
            print(f"wrote {OUT / name}")
        browser.close()

if __name__ == "__main__":
    main()
