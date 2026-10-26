"""Synthetic browser regression for live-window costs and extracted tile styles."""
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
server = subprocess.Popen([os.environ.get("BUN_BIN") or shutil.which("bun"), "scripts/current-fixture.ts"],
                          cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
checks = []
try:
    first = server.stdout.readline().strip()
    assert first.startswith("CURRENT_FIXTURE_URL="), first
    url = first.split("=", 1)[1]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_BIN"), headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        context.route("https://fonts.googleapis.com/**", lambda route: route.abort())
        context.route("https://fonts.gstatic.com/**", lambda route: route.abort())
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        pending = []
        mode = {"empty": False, "hold": False, "partial": False}

        def series(route):
            response = route.fetch()
            data = response.json()
            for cycle in data["cycles"]:
                cycle["sample_count"] = 0
                cycle["usd"] = 0
            route.fulfill(response=response, json=data)

        def costs(route):
            response = route.fetch()
            data = response.json()
            account = parse_qs(urlparse(route.request.url).query)["account"][0]
            data["totals"].update(calls=0 if mode["empty"] else 2, usd=0 if mode["empty"] else 1.25 if account == "codex1" else 2.5)
            data["unpriced"] = {"tokens": 0, "models": {}}
            data["credit_equivalent"] = {"value": None if mode["empty"] else 31.25, "priced_credits": 0 if mode["empty"] else 31.25, "unpriced_calls": 0, "basis": "standard-reference"}
            if mode["partial"]:
                data["credit_equivalent"].update(value=None, unpriced_calls=1)
                data["unpriced"] = {"tokens": 100, "models": {"unknown": 100}}
            if mode["hold"] and account == "codex2":
                pending.append((route, response, data))
            else:
                route.fulfill(response=response, json=data)

        page.route("**/api/usage-series?*", series)
        page.route("**/api/cycle-breakdown?*", costs)
        page.goto(url, wait_until="networkidle")
        tile = page.locator(".ui-kpi-cell").filter(has=page.get_by_text("Koszt API-eq", exact=True))
        expect(tile.locator(".ui-kpi-value")).to_have_text("$1.25")
        credit_tile = page.locator(".ui-kpi-cell").filter(has=page.get_by_text("Kredyty eq", exact=True))
        expect(credit_tile.locator(".ui-kpi-value")).to_have_text("≈ 31,25")
        expect(credit_tile.locator(".ui-kpi-note")).to_have_text("kredyty · Standard")
        checks.append("API-equivalent cost renders without indexed gauge samples")
        for width, columns in [(1920, 5), (900, 3), (390, 2)]:
            page.set_viewport_size({"width": width, "height": 1080})
            expect(page.locator(".ui-kpi-strip")).to_have_css("gap", "1px")
            page.wait_for_function("n => getComputedStyle(document.querySelector('.ui-kpi-strip')).gridTemplateColumns.split(' ').length === n", arg=columns)
            expect(tile).to_have_css("padding", "5px 10px 6px")
            expect(tile.locator(".ui-kpi-value")).to_have_css("font-size", "18px")
            expect(tile.locator(".ui-kpi-label")).to_have_css("font-size", "9px")
            expect(page.locator(".overview-section").first).to_have_css("gap", "10px")
            expect(page.locator(".overview-section-title").first).to_have_css("font-size", "14px")
            checks.append(f"{width}px shared tile geometry and typography preserved")
        page.set_viewport_size({"width": 1920, "height": 1080})
        mode["hold"] = True
        page.locator("main select").first.select_option("codex2")
        expect(tile.locator(".ui-kpi-value")).not_to_have_text("$1.25")
        expect(credit_tile.locator(".ui-kpi-value")).to_have_text("—")
        page.wait_for_timeout(100)
        assert pending, "Expected a pending cost response for the new account"
        for route, response, data in pending:
            route.fulfill(response=response, json=data)
        expect(tile.locator(".ui-kpi-value")).to_have_text("$2.50")
        checks.append("switching accounts clears the previous cost while the new response is pending")
        mode.update(empty=True, hold=False)
        page.reload(wait_until="networkidle")
        expect(tile.locator(".ui-kpi-value")).to_have_text("—")
        expect(credit_tile.locator(".ui-kpi-value")).to_have_text("—")
        checks.append("an empty indexed window remains unavailable instead of showing zero dollars")
        mode.update(empty=False, partial=True)
        page.reload(wait_until="networkidle")
        expect(credit_tile.locator(".ui-kpi-note")).to_have_text("bez stawki: 1 wywołań")
        expect(credit_tile.locator(".ui-kpi-value")).to_have_text("≥ 31,25")
        expect(tile.locator(".ui-kpi-value")).to_contain_text("≥")
        checks.append("partial API and credit valuations show lower bounds instead of complete totals")
        assert not errors, errors
        browser.close()
    print(json.dumps({"passed": len(checks), "checks": checks, "page_errors": errors}, indent=2))
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
