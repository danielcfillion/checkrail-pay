#!/usr/bin/env python3
"""
Take the README screenshots from a running Checkrail Pay server.

    npm run db:seed && npm run dev          # in one terminal
    python3 scripts/screenshots.py          # in another; writes docs/screenshots/*.png

The last two shots run /demo steps 6 and 7 (Rosa's trip sheet, then Autopilot on), so seed again afterwards;
set SKIP_FLOW=1 to skip them.

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
        "vnd": by_ref.get("HS-1027"),
        "deposit": by_ref.get("INV-DML-1010"),
    }

def main():
    ids = story_ids()
    headers = {}
    auth = os.environ.get("SCREENSHOT_AUTH") or os.environ.get("CHECKRAIL_BASIC_AUTH")
    if not auth and os.environ.get("CHECKRAIL_USERS"):
        # First configured login, user:password (the role part is dropped).
        auth = ":".join(os.environ["CHECKRAIL_USERS"].split(",")[0].split(":")[:2])
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
        ("vnd-invoice.png", f"/obligations/{ids['vnd']}", 1440, 1500, "light"),
        ("deposit.png", f"/obligations/{ids['deposit']}", 1440, 1300, "light"),
        ("vendor-checks.png", "/vendors", 1440, 1300, "light"),
        ("payment-runs.png", "/runs", 1440, 1000, "light"),
        ("books.png", "/books", 1440, 1200, "light"),
        ("departures.png", "/departures", 1440, 900, "light"),
        ("team.png", "/settings#team", 1440, 1100, "light"),
        ("blocked-mismatch-mobile.png", f"/obligations/{ids['mismatch']}", 390, 844, "light"),
        ("daily-close-mobile.png", "/close", 390, 844, "light"),
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
        if os.environ.get("SKIP_FLOW") != "1":
            autopilot_flow(browser, headers)
        browser.close()


def autopilot_flow(browser, headers):
    """/demo steps 6 and 7: Rosa's trip sheet read from the PDF, then Autopilot scheduling it. Changes the demo state."""
    import re
    docs = Path(__file__).resolve().parent.parent / "public" / "demo-documents"
    ctx = browser.new_context(viewport={"width": 1440, "height": 1100}, color_scheme="light", extra_http_headers=headers, device_scale_factor=2)
    page = ctx.new_page()
    page.set_default_timeout(30000)
    page.goto(BASE + "/obligations/new", wait_until="networkidle")
    page.fill("#raw", "Trip sheet attached for Rosa, please pay.")
    page.locator("input[type=file]").first.set_input_files(str(docs / "tripsheet-ceb2d-1024.pdf"))
    page.get_by_text(re.compile("read by the PDF text reader", re.I)).first.wait_for()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "evidence-from-pdf.png"))
    print(f"wrote {OUT / 'evidence-from-pdf.png'}")
    page.get_by_role("button", name=re.compile(r"^Create (obligation|request)$")).click()
    page.wait_for_url(re.compile(r"/obligations/obl_"))
    page.wait_for_load_state("networkidle")
    page.goto(BASE + "/settings", wait_until="networkidle")
    page.get_by_role("radio", name=re.compile(r"^Autopilot")).click()
    page.get_by_role("button", name="Turn on autopilot").click()
    page.get_by_role("button", name="Yes, turn on autopilot").click()
    page.get_by_text("Autopilot is on.").first.wait_for()
    page.goto(BASE + "/", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "autopilot-scheduled.png"))
    print(f"wrote {OUT / 'autopilot-scheduled.png'}")
    ctx.close()

if __name__ == "__main__":
    main()
