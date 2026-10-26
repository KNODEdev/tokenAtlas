"""Browser acceptance of the restored, user-approved Overview and retained current APIs.

The user rejected the replacement portfolio entry on 2026-09-06. The former
bootstrap-only/lazy-portfolio browser contract is superseded, not reported PASS.
Run after bun run build:web. Only synthetic data and the actual router are used.
BUN_BIN / CHROMIUM_BIN can override installed executables.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BUN = os.environ.get("BUN_BIN") or shutil.which("bun")
if not BUN:
    raise RuntimeError("Bun is required (or set BUN_BIN).")
server = subprocess.Popen([BUN, "scripts/current-fixture.ts"], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
assert server.stdout is not None
checks = []
observations = {}
try:
    first = server.stdout.readline().strip()
    if not first.startswith("CURRENT_FIXTURE_URL="):
        stderr = server.stderr.read() if server.stderr else ""
        raise RuntimeError(f"Fixture did not start: {first}\n{stderr}")
    url = first.split("=", 1)[1]
    with sync_playwright() as p:
        binary = os.environ.get("CHROMIUM_BIN") or shutil.which("chromium")
        browser = p.chromium.launch(executable_path=binary, args=["--no-sandbox"], headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        context.route("https://fonts.googleapis.com/**", lambda route: route.abort())
        context.route("https://fonts.gstatic.com/**", lambda route: route.abort())
        # The rejected entry may have left this key on the operator's computer.
        context.add_init_script("localStorage.setItem('tokenatlas.current-subscription', '__all__')")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        output = os.environ.get("CURRENT_SCREENSHOT_DIR")
        if output:
            Path(output).mkdir(parents=True, exist_ok=True)

        def screenshot(name):
            if output:
                page.screenshot(path=str(Path(output) / name), full_page=True)

        def overview(polish=False):
            expect(page.get_by_role("heading", name="Przegląd" if polish else "Overview", exact=True)).to_be_visible()
            tabs = page.get_by_role("tablist", name="Sekcje przeglądu" if polish else "Overview sections", exact=True)
            labels = ["Prognoza i budżet", "Modele i ruch", "Historia okien", "Dane i kalibracja"] if polish else [
                "Forecast and budget", "Models and traffic", "Window history", "Data and calibration"]
            expect(tabs.get_by_role("tab")).to_have_text(labels)
            tabs.get_by_role("tab", name=labels[0], exact=True).click()
            expect(page.get_by_text(re.compile(r"^(Budżet okna|Window budget) ·"))).to_be_visible()
            tabs.get_by_role("tab", name=labels[1], exact=True).click()
            expect(page.locator("main h2")).to_have_text([
                "Modele w oknie", "Skład ruchu"] if polish else ["Models in window", "Traffic composition"])
            tabs.get_by_role("tab", name=labels[2], exact=True).click()
            expect(page.get_by_text(re.compile(r"^(Historia cykli|Cycle history) ·"))).to_be_visible()
            tabs.get_by_role("tab", name=labels[3], exact=True).click()
            expect(page.locator("main h2")).to_have_text([
                "Proweniencja danych", "Kalibracja i obserwacje"] if polish else ["Data provenance", "Calibration and observations"])
            tabs.get_by_role("tab", name=labels[0], exact=True).click()
            expect(page.locator(".current-shell")).to_have_count(0)
            expect(page.get_by_role("heading", name="Portfolio subskrypcji", exact=True)).to_have_count(0)

        page.goto(url, wait_until="networkidle")
        overview()
        expect(page.locator("html")).to_have_attribute("lang", "en")
        page.get_by_role("button", name="Polski", exact=True).click()
        overview(polish=True)
        page.reload(wait_until="networkidle")
        expect(page.locator("html")).to_have_attribute("lang", "pl")
        overview(polish=True)
        page.get_by_role("button", name="English", exact=True).click()
        overview()
        checks.append("English default, Polish switch and persisted language preserve the approved September 26 Overview tabs")
        expect(page.locator("main select").first).to_have_value("codex1")
        expect(page.locator("aside.shell-nav, aside.subs-rail, aside.window-rail")).to_have_count(3)
        expect(page.get_by_text("Subscriptions", exact=True)).to_be_visible()
        expect(page.get_by_text("Weekly windows", exact=True)).to_be_visible()
        expect(page.get_by_text(re.compile(r"^Window budget ·"))).to_be_visible()
        # Original 204px navigation + 296px subscriptions + 176px windows.
        assert abs(page.locator("main").bounding_box()["x"] - 676) < 1
        screenshot("overview-desktop-dark.png")
        checks.append("approved Overview tabs, budget, history, models, traffic, data and calibration with all three rails")

        expect(page.locator("main select")).to_have_count(3)
        expect(page.get_by_role("button", name="↻ Synchronize", exact=True)).to_be_visible()
        page.get_by_role("button", name="tokens", exact=True).click()
        page.get_by_role("button", name="%", exact=True).click()
        page.locator("main select").first.select_option("codex2")
        overview()
        expect(page.locator("main select").first).to_have_value("codex2")
        page.locator("main select").first.select_option("codex1")
        checks.append("original subscription/project/window filters, unit controls and sync button remain")

        page.get_by_role("navigation").get_by_role("button", name="History", exact=False).click()
        expect(page.get_by_role("heading", name="History", exact=True)).to_be_visible()
        page.get_by_role("navigation").get_by_role("button", name="Overview", exact=False).click()
        overview()
        expect(page.locator("aside.shell-nav, aside.subs-rail, aside.window-rail")).to_have_count(3)
        checks.append("History returns to the same original Overview, not the rejected portfolio")

        page.keyboard.press("Control+k")
        expect(page.get_by_placeholder("Search a screen, cycle, or action...")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_placeholder("Search a screen, cycle, or action...")).to_have_count(0)
        checks.append("original command palette and Escape behaviour are restored")

        page.get_by_role("button", name="Light", exact=True).click()
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        screenshot("overview-desktop-light.png")
        page.reload(wait_until="networkidle")
        overview()
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        checks.append("original light/dark theme and persisted theme work")

        bootstrap = page.request.get(url + "/api/bootstrap")
        assert bootstrap.status == 200 and bootstrap.json()["status"] == "ready"
        current = page.request.get(url + "/api/subscriptions/codex1/current")
        assert current.status == 200 and current.json()["data"]["id"] == "codex1"
        assert current.json()["data"]["limits"][0]["used_percent"] == 37
        conditional = page.request.get(url + "/api/subscriptions/codex1/current",
                                       headers={"If-None-Match": current.headers["etag"]})
        assert conditional.status == 304
        assert page.request.get(url + "/api/revisions").status == 200
        checks.append("durable bootstrap/current/revisions APIs and conditional reads remain available")

        assert not errors, errors
        browser.close()
    print(json.dumps({"passed": len(checks), "checks": checks, "page_errors": errors, "observations": observations}, ensure_ascii=False, indent=2))
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
