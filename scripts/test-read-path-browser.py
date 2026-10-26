"""Synthetic browser proof for empty/indexed Overview read paths and delayed readiness."""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BUN = os.environ.get("BUN_BIN") or shutil.which("bun")
DELAY_MS = 600


def browser_binary():
    # Use Playwright's pinned Chromium by default on both workflow platforms.
    return os.environ.get("CHROMIUM_BIN") or shutil.which("chromium")


def run_fixture(root: Path) -> dict:
    result = subprocess.run(
        [BUN, "scripts/lib/read-path-harness.ts", "create-synthetic", "--root", str(root)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    paths = json.loads(result.stdout)
    # Distinguish equal-length historical windows in this disposable fixture.
    with sqlite3.connect(paths["databaseCopy"]) as db:
        for cycle, tokens in [(0, 123400), (1, 567800)]:
            changed = db.execute("UPDATE events SET in_tok = ? WHERE path LIKE ?", (tokens, f"%/synthetic-{cycle}.jsonl"))
            assert changed.rowcount > 0, "historical synthetic usage was not seeded"
    return paths


def window_expectation(paths, account, cycle, number):
    config = json.loads(Path(paths["configCopy"]).read_text(encoding="utf-8"))
    logical = config["_read_path_harness"]["logical_context"]
    with sqlite3.connect(paths["databaseCopy"]) as db:
        source = db.execute("SELECT source FROM account_periods WHERE provider = 'codex' AND account = ? LIMIT 1", (account,)).fetchone()[0]
    folder = source.split("/", 1)[1]
    def expanded_home(row):
        value = row["home"]
        for macro, key in [("ARCHIVE", "archive"), ("PROFILE", "profile")]:
            value = value.replace("${" + macro + "}", logical[key])
        return os.path.normpath(value)
    home = next(expanded_home(row) for row in config["sources"] if os.path.basename(expanded_home(row)).lower() == folder.lower())
    identity = {"account": account, "since_ts": cycle["work_from_ts"],
                "until_ts": cycle["work_to_ts"], "anchor": str(cycle["anchor"])}
    with sqlite3.connect(paths["databaseCopy"]) as db:
        rows = db.execute("""SELECT date(ts, 'localtime'), COUNT(*), SUM(in_tok + out_tok)
            FROM events WHERE home = ? AND ts >= ? AND ts <= ? GROUP BY 1""",
            (home, identity["since_ts"], identity["until_ts"])).fetchall()
        gauges = db.execute("""SELECT date(ts, 'localtime'), used_percent FROM ratelimit
            WHERE home = ? AND ts >= ? AND ts <= ? AND limit_id = 'codex'
            AND window_minutes > 300 AND ABS(resets_at - ?) <= 120 ORDER BY ts""",
            (home, identity["since_ts"], identity["until_ts"], cycle["anchor"])).fetchall()
    days = {date: {"calls": calls, "tokens": tokens} for date, calls, tokens in rows}
    gauge_days = {}
    for date, value in gauges:
        gauge_days[date] = {"gauge_end": value, "gauge_samples": gauge_days.get(date, {}).get("gauge_samples", 0) + 1}
    assert days and gauges and cycle["sample_count"] > 0, "historical fixture window is not indexed"
    return {"identity": identity, "number": number, "days": days, "gauges": gauge_days}


def assert_window_response(expected, observation):
    identity, body = expected["identity"], observation["body"]
    assert observation["request_identity"] == identity, "request window identity mismatch"
    assert {key: body[key] for key in ["account", "since_ts", "until_ts"]} == {
        key: identity[key] for key in ["account", "since_ts", "until_ts"]
    }, "response window identity mismatch"
    assert body["limit_id"] == "codex" and body["session_window_minutes"] == 300
    assert set(expected["days"]).issubset({day["date"] for day in body["days"]}), "response dates do not cover fixture events"
    for day in body["days"]:
        usage = expected["days"].get(day["date"], {"calls": 0, "tokens": 0})
        assert {key: day[key] for key in usage} == usage, "response usage differs from selected fixture window"
        gauge = expected["gauges"].get(day["date"], {"gauge_end": None, "gauge_samples": 0})
        assert {key: day[key] for key in gauge} == gauge, "response gauge differs from selected fixture anchor"
    assert body["totals"]["calls"] == sum(day["calls"] for day in expected["days"].values())
    assert body["totals"]["tokens"] == sum(day["tokens"] for day in expected["days"].values())


def assert_window_render(page, expected):
    date, values = next(iter(expected["days"].items()))
    row = page.locator(f'main div[title^="{date} ·"][title*=" h w oknie "]')
    expect(row).to_be_visible()
    # The deliberately distinct synthetic totals are in compact()'s >=100k range.
    assert 100000 <= values["tokens"] < 1000000
    token_text = f"{int(values['tokens'] / 1000 + 0.5)}k"
    expect(row.locator(":scope > span").nth(3)).to_have_text(token_text)
    expect(row.locator(":scope > span").nth(4)).to_have_text(str(values["calls"]))
    return {"date": date, "tokens": row.locator(":scope > span").nth(3).inner_text(),
            "calls": row.locator(":scope > span").nth(4).inner_text()}


def select_historical_window(page, breakdowns, expected, received_after=None):
    # received_after excludes observations made before a route change or reload; without it a
    # control could pass on a response that never went through the route under test.
    started = time.perf_counter()
    rail = page.locator("aside").filter(has_text="Okna tygodniowe")
    rail.get_by_role("button", name=re.compile(rf"^#{expected['number']}\b")).click()
    deadline = started + 5
    observation = None
    while time.perf_counter() < deadline:
        observation = next((row for row in reversed(breakdowns)
                            if row["request_identity"] == expected["identity"]
                            and (received_after is None or row["received_at"] > received_after)), None)
        if observation:
            break
        page.wait_for_timeout(25)
    assert observation is not None, "historical rail selection lacks a response for the expected account/window/anchor"
    # Overview prefetches historical windows. A click may reuse that exact response through the API memo.
    return {**observation, "delivery": "prefetched" if observation["received_at"] < started else "requested"}


def start_server(paths: dict) -> tuple[subprocess.Popen, str]:
    server = subprocess.Popen(
        [
            BUN,
            "scripts/lib/read-path-harness.ts",
            "serve",
            "--db-copy", paths["databaseCopy"],
            "--config-copy", paths["configCopy"],
            "--archive-copy", paths["archiveCopy"],
            "--work-dir", paths["workDir"],
            "--out", paths["output"],
            "--delay-ms", str(DELAY_MS),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert server.stdout is not None
    for _ in range(30):
        line = server.stdout.readline().strip()
        if line.startswith("READ_PATH_HARNESS_URL="):
            return server, line.split("=", 1)[1]
        if server.poll() is not None:
            break
    stderr = server.stderr.read() if server.stderr else ""
    raise RuntimeError(f"isolated harness did not start ({server.returncode}): {stderr[-500:]}")


def sample_counts(document):
    found = []
    if isinstance(document, dict):
        for key, value in document.items():
            if key == "sample_count" and isinstance(value, (int, float)):
                found.append(value)
            else:
                found.extend(sample_counts(value))
    elif isinstance(document, list):
        for value in document:
            found.extend(sample_counts(value))
    return found


def main(output: Path | None) -> dict:
    if not BUN:
        raise RuntimeError("Bun is required (or set BUN_BIN).")
    boundary = subprocess.run(
        [BUN, "test", "src/server/cycle-breakdown-read.test.ts", "--test-name-pattern", "inclusive boundary regression"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "CYCLE_BOUNDARY_MUTANT": "1"},
    )
    assert boundary.returncode != 0 and "inclusive boundary regression" in boundary.stderr and "expect(received)" in boundary.stderr, "boundary SQL mutation was not rejected by regression assertions"
    if not (ROOT / "public" / "index.html").exists():
        raise RuntimeError("Committed UI assets are missing; run bun run build:web first.")
    root = Path(tempfile.mkdtemp(prefix="ta-read-path-browser-"))
    server = None
    browser = None
    try:
        paths = run_fixture(root)
        server, url = start_server(paths)
        breakdowns = []
        usage_series = {}
        request_started = {}
        browser_routes = []
        errors = []
        with sync_playwright() as playwright:
            binary = browser_binary()
            browser = playwright.chromium.launch(executable_path=binary, args=["--no-sandbox"], headless=True)
            context = browser.new_context(viewport={"width": 1920, "height": 1080})
            context.route("https://fonts.googleapis.com/**", lambda route: route.abort())
            context.route("https://fonts.gstatic.com/**", lambda route: route.abort())
            # This read-path contract uses Polish labels; language switching has its own smoke test.
            context.add_init_script("localStorage.setItem('tokenatlas.language', 'pl')")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))

            def on_request(request):
                parsed = urlparse(request.url)
                if parsed.path.startswith("/api/"):
                    request_started[id(request)] = time.perf_counter()

            def on_response(response):
                parsed = urlparse(response.url)
                if not parsed.path.startswith("/api/"):
                    return
                started = request_started.pop(id(response.request), None)
                browser_routes.append({
                    "route_alias": parsed.path,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000, 3) if started is not None else None,
                    "status": response.status,
                })
            def on_request_finished(request):
                # Navigation can cancel responses after headers. Read bodies only after completion.
                parsed = urlparse(request.url)
                if parsed.path not in ("/api/cycle-breakdown", "/api/usage-series"):
                    return
                response = request.response()
                if response is None or response.status != 200:
                    return
                query = parse_qs(parsed.query)
                account = query.get("account", [None])[0]
                if parsed.path == "/api/cycle-breakdown" and response.ok:
                    body = response.json()
                    breakdowns.append({
                        "account_alias": account,
                        "request_identity": {key: query.get(key, [None])[0] for key in ["account", "since_ts", "until_ts", "anchor"]},
                        "body": body,
                        "received_at": time.perf_counter(),
                        "days": len(body.get("days", [])),
                    })
                if parsed.path == "/api/usage-series" and response.ok and account:
                    usage_series[account] = response.json()

            page.on("request", on_request)
            page.on("response", on_response)
            page.on("requestfinished", on_request_finished)
            planhealth = page.request.get(url + "/__read-path-report").json()["planhealth"]
            assert planhealth["status"] == "PASS"
            for case in planhealth["cases"]:
                response = page.goto(url + "/api/planhealth?account=" + case["account"], wait_until="networkidle")
                assert response is not None and response.status == case["status"]
                assert response.json() == case["expected"], "planhealth browser full response changed"
            page.goto(url, wait_until="networkidle")
            expect(page.get_by_role("heading", name="Przegląd", exact=True)).to_be_visible()
            account_select = page.locator("main select").first
            account_select.select_option("indexed-a")
            expect(account_select).to_have_value("indexed-a")
            first_deadline = time.perf_counter() + 5
            first = None
            while time.perf_counter() < first_deadline:
                first = next((row for row in reversed(breakdowns) if row["account_alias"] == "indexed-a"), None)
                if first and usage_series.get("indexed-a") is not None:
                    break
                page.wait_for_timeout(25)
            assert first is not None, "indexed-a did not call cycle-breakdown"
            first_counts = sample_counts(usage_series.get("indexed-a"))
            assert any(value > 0 for value in first_counts), "indexed-a lacks sample_count > 0"
            # The user-approved September 26 tabs place the day and session charts under Models and traffic.
            page.get_by_role("tab", name="Modele i ruch", exact=True).click()
            first_summary = page.get_by_text(re.compile(r"^\d+ dni tego okna"))
            expect(first_summary).to_be_visible()

            numbered = list(enumerate(sorted((cycle for cycle in usage_series["indexed-a"]["cycles"]
                                             if not cycle["shadow"]), key=lambda cycle: cycle["index"]), 1))
            historical = [window_expectation(paths, "indexed-a", cycle, number) for number, cycle in numbered
                          if not cycle["is_active"] and cycle["sample_count"] > 0]
            assert len(historical) >= 2, "two indexed historical rail windows are required"
            earlier, later = historical[:2]
            earlier_response = select_historical_window(page, breakdowns, earlier)
            assert_window_response(earlier, earlier_response)
            earlier_render = assert_window_render(page, earlier)
            later_response = select_historical_window(page, breakdowns, later)
            assert_window_response(later, later_response)
            later_render = assert_window_render(page, later)
            assert len(earlier_response["body"]["days"]) == len(later_response["body"]["days"]), "control must preserve day count"
            assert earlier_response["body"]["totals"]["tokens"] != later_response["body"]["totals"]["tokens"], "fixture windows must render distinct usage"

            stale_served = []

            def stale_window(route):
                query = parse_qs(urlparse(route.request.url).query)
                if all(query.get(key, [None])[0] == value for key, value in later["identity"].items()):
                    stale_served.append(time.perf_counter())
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(earlier_response["body"]))
                else:
                    route.continue_()

            page.route("**/api/cycle-breakdown?**", stale_window)
            routed_at = time.perf_counter()
            page.reload(wait_until="networkidle")
            account_select.select_option("indexed-a")
            wrong_response = select_historical_window(page, breakdowns, later, received_after=routed_at)
            assert stale_served and stale_served[0] < wrong_response["received_at"], "stale control body was not served by the route"
            # Establish that the same-length stale body really reached the DOM.
            assert_window_render(page, earlier)
            try:
                assert_window_response(later, wrong_response)
            except AssertionError as error:
                assert str(error) == "response window identity mismatch"
            else:
                raise AssertionError("wrong-window browser response was accepted")
            spoofed_body = json.loads(json.dumps(later_response["body"]))
            for target, stale in zip(spoofed_body["days"], earlier_response["body"]["days"]):
                target["tokens"] = stale["tokens"]
            spoofed = {**wrong_response, "body": spoofed_body}
            try:
                assert_window_response(later, spoofed)
            except AssertionError as error:
                assert str(error) == "response usage differs from selected fixture window"
            else:
                raise AssertionError("stale content with matching response identity was accepted")
            page.unroute("**/api/cycle-breakdown?**", stale_window)
            unrouted_at = time.perf_counter()
            page.reload(wait_until="networkidle")
            account_select.select_option("indexed-a")
            restored = select_historical_window(page, breakdowns, later, received_after=unrouted_at)
            assert_window_response(later, restored)
            assert_window_render(page, later)

            previous_breakdowns = len(breakdowns)
            switch_started = time.perf_counter()
            account_select.select_option("indexed-b")
            page.wait_for_timeout(120)
            expect(page.get_by_role("heading", name="Przegląd", exact=True)).to_be_visible()
            delayed_negative_pass = len(breakdowns) == previous_breakdowns
            stale_or_heading_was_insufficient = delayed_negative_pass
            deadline = time.perf_counter() + 5
            second = None
            while time.perf_counter() < deadline:
                candidates = [
                    row for row in breakdowns
                    if row["account_alias"] == "indexed-b" and row["received_at"] >= switch_started
                ]
                rendered = page.locator("main").inner_text()
                second = next((row for row in reversed(candidates) if f"{row['days']} dni tego okna" in rendered), None)
                if second is not None:
                    break
                page.wait_for_timeout(25)
            assert second is not None, "indexed-b response did not reach a context-correct render"
            indexed_ready_ms = round((time.perf_counter() - switch_started) * 1000, 3)
            assert indexed_ready_ms >= DELAY_MS * 0.8, "screen-ready ignored the delayed context route"
            second_counts = sample_counts(usage_series.get("indexed-b"))
            assert any(value > 0 for value in second_counts), "indexed-b lacks sample_count > 0"

            empty_started = time.perf_counter()
            account_select.select_option("empty")
            empty_marker = page.get_by_text(re.compile(
                r"Indeks bieżącego okna jeszcze bez danych|Konto jest bezczynne|Brak aktywnego cyklu"
            ))
            expect(empty_marker.first).to_be_visible()
            empty_ready_ms = round((time.perf_counter() - empty_started) * 1000, 3)
            page.wait_for_timeout(DELAY_MS + 100)
            empty_counts = sample_counts(usage_series.get("empty"))
            assert not any(value > 0 for value in empty_counts), "empty window was not proven empty"
            empty_breakdown_requests = sum(row["account_alias"] == "empty" for row in breakdowns)

            # Requests of the account switch above may still be arriving on a slow runner; count from quiet.
            page.wait_for_load_state("networkidle")
            # The status bar polls background-work state on its own timer; that is not a data read of the transition.
            status_polls = {"/api/app-activity", "/api/analysis/rebuild", "/api/sync"}
            def data_requests(rows):
                return [row["route_alias"] for row in rows if row["route_alias"] not in status_polls]
            before_client_only = len(browser_routes)
            client_started = time.perf_counter()
            page.get_by_role("button", name="tokeny", exact=True).click()
            page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            client_only_ms = round((time.perf_counter() - client_started) * 1000, 3)
            page.wait_for_timeout(100)
            assert not data_requests(browser_routes[before_client_only:]), \
                f"client-only unit transition made an API request: {data_requests(browser_routes[before_client_only:])}"

            harness_report = page.request.get(url + "/__read-path-report").json()
            parity = harness_report["parity"]
            assert parity["status"] == "pass", "real-handler full-response parity did not pass"
            assert parity["full_response_reference_matches"] is True
            assert parity["full_response_candidate_matches"] is True
            assert parity["repeated_real_handler_parity"] is True
            assert {row["pointer"] for row in parity["clock_policy"]} == {
                "/scope/since_ts", "/scope/until_ts"
            }
            assert all(parity["mutation_controls"].values()), "protected-field mutation control failed"
            cycle_parity = parity["cycle_breakdown"]
            assert cycle_parity["status"] == "pass"
            assert cycle_parity["route_alias"] == "/api/cycle-breakdown"
            assert cycle_parity["full_response_reference_matches"] is True
            assert cycle_parity["full_response_candidate_matches"] is True
            assert cycle_parity["repeated_real_handler_parity"] is True
            assert len(cycle_parity["clock_policy"]) == 14
            assert all(cycle_parity["mutation_controls"].values()), "cycle protected-field control failed"
            blocked_requests = sum(row["status"] == 405 for row in browser_routes)
            assert blocked_requests == 0, f"approved Overview requested unaudited routes: {[row['route_alias'] for row in browser_routes if row['status'] == 405]}"
            assert not errors, errors
            browser.close()
            browser = None

        result = {
            "schema_version": 2,
            "kind": "synthetic-read-path-browser-evidence",
            "status": "PASS",
            "coverage": {
                "boundary_sql_mutation": {"status": "PASS", "mutation": "ledger instant_ms <= until becomes < until", "regression_rejected": True},
                "planhealth": {"status": "PASS", "full_response_cases": 4, "subsequent_overview_navigation": True},
                "indexed_window": {"status": "PASS", "sample_count_positive": True,
                    "cycle_breakdown_requests": sum(row["account_alias"] in ("indexed-a", "indexed-b") for row in breakdowns)},
                "historical_rail_windows": {"status": "PASS", "selected_windows": 2,
                    "request_account_bounds_anchor_match": True, "response_identity_and_fixture_values_match": True,
                    "distinctive_dates_tokens_calls_rendered": True, "same_day_count_stale_response_rejected": True,
                    "spoofed_identity_stale_content_rejected": True, "real_response_restored": True,
                    "windows": [{"rail_number": expected["number"], "expected": expected["identity"],
                        "request": observation["request_identity"],
                        "delivery": observation["delivery"],
                        "response": {key: observation["body"][key] for key in ["account", "since_ts", "until_ts"]},
                        "day_count": len(observation["body"]["days"]), "rendered_witness": rendered}
                        for expected, observation, rendered in [(earlier, earlier_response, earlier_render),
                                                               (later, later_response, later_render)]]},
                "empty_window": {
                    "status": "PASS",
                    "sample_count_zero": True,
                    "context_correct_empty_render": True,
                    "cycle_breakdown_requests": empty_breakdown_requests,
                },
                "delayed_conditional_route": {
                    "status": "PASS",
                    "delay_ms": DELAY_MS,
                    "heading_visible_before_ready": True,
                    "stale_or_heading_insufficient": stale_or_heading_was_insufficient,
                    "screen_ready_waited_for_context_response": delayed_negative_pass,
                },
            },
            "timing": {
                "sql": None,
                "route": {
                    "browser_samples": browser_routes,
                    "server_samples": harness_report["timing"]["route"]["samples"],
                },
                "context": harness_report["timing"]["context"],
                "process": None,
                "browser": {
                    "clock": "time.perf_counter monotonic",
                    "indexed_context_ready_ms": indexed_ready_ms,
                    "empty_context_ready_ms": empty_ready_ms,
                    "client_only_transition_ms": client_only_ms,
                    "client_only_request_count": 0,
                    "missing_timer_policy": "null/NOT-RUN",
                },
            },
            "safety": harness_report["safety"],
            "parity": parity,
            "environment": {"status": "synthetic-local", "browser": "chromium", "ui_assets": "committed-build"},
            "failure": {"page_errors": 0, "blocked_requests": blocked_requests},
        }
        if output:
            output.parent.mkdir(parents=False, exist_ok=True)
            with output.open("x", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
        return result
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    print(json.dumps(main(args.out), ensure_ascii=False, indent=2))
