import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClaudeCurrentWindow, ClaudeLimitResponse, ClaudeSurfaceBreakdown } from "../lib/api";
import type { ClaudeCodeCapacitySummary } from "../../shared/claude-code-capacity";
import { buildWindowInsights } from "../lib/window-insights";
import type { RailWindow } from "../lib/windows";
import { claudeSections } from "./ClaudeSections";
import { VendorOverview } from "./VendorOverview";
import { setLanguage } from "../lib/i18n";
import { decodeCreditPools, creditPoolsInRange } from "../../shared/credit-pools";

afterEach(() => setLanguage("en"));

const hour = 3_600_000;
const spend = { calls: 14249, usd: 1860.13, gross: 2_726_778_490, fresh: 21_500_000 };
function current(windowStart: string, resetAt: string, live: boolean): ClaudeCurrentWindow {
  return {
    window_start: windowStart,
    reset_at: resetAt,
    elapsed_hours: live ? 154 : 168,
    remaining_hours: live ? 14 : 0,
    elapsed_percent: live ? 91.67 : 100,
    spend,
    fable_spend: { calls: 0, usd: 0, gross: 0, fresh: 0 },
    percent_all_measured: live ? 57 : null,
    percent_fable_measured: null,
    measured_at: live ? resetAt : null,
    measured_age_minutes: live ? 1 : null,
    percent_all_est: null,
    percent_fable_est: null,
    pp_ahead: null,
    projected_end_percent: null,
    eta_100_iso: null,
    remaining_usd: null,
    surface_breakdown: null,
  };
}
function report(cur: ClaudeCurrentWindow): ClaudeLimitResponse {
  return {
    configured: true,
    plan: "pro",
    window_hours: 168,
    fable_share_of_all: null,
    observations: [],
    calibration: null,
    models: [],
    current: cur,
    session: null,
    probe: {
      ok: true, ts: null, age_minutes: null, weekly_percent: null, weekly_fable_percent: null,
      weekly_resets_at: null, session_percent: null, session_resets_at: null, samples: 0,
    },
    caveats: [],
  };
}
const render = (cur: ClaudeCurrentWindow) =>
  renderToStaticMarkup(<VendorOverview sections={claudeSections({ capabilities: null, data: report(cur) })} />);

describe("Claude overview window label", () => {
  it("names the dates of a window that has already reset instead of calling it current", () => {
    const html = render(current("2026-08-30T11:00:00.000Z", "2026-09-06T11:00:00.000Z", false));

    expect(html).toContain('dateTime="2026-08-30T11:00:00.000Z"');
    expect(html).toContain('dateTime="2026-09-06T11:00:00.000Z"');
    // The state is in the context bar; a closed window keeps its own plan beside its title.
    expect(html).toContain('<span class="sub-card-plan">');
    expect(html).toContain("Window result");
    // A finished window has no countdown left to advertise.
    expect(html).not.toContain("Until reset");
  });

  it("keeps the live window on its countdown", () => {
    const resetAt = new Date(Date.now() + 14 * hour).toISOString();
    const html = render(current(new Date(Date.now() - 154 * hour).toISOString(), resetAt, true));

    expect(html).toContain("7d week");
    expect(html).not.toContain(" · current · ");
    expect(html).toContain("Until reset");
    expect(html).not.toContain("Window result");
  });
});

describe("Claude used-bar split by surface", () => {
  const breakdown: ClaudeSurfaceBreakdown = {
    schema: 1,
    as_of: "2026-09-19T22:00:00.000Z",
    window_started_at: "2026-09-13T11:00:00.000Z",
    rows: [
      { key: "claude_code", percent: 62, display_name: "Claude Code" },
      { key: "cowork", percent: 21, display_name: "Cowork" },
      { key: "chat", percent: 9, display_name: "Chats" },
      { key: "other", percent: 8, display_name: "Other" },
    ],
  };

  it("names every surface and states how much of the bar the index cannot see", () => {
    const cur = current("2026-09-13T11:00:00.000Z", "2026-09-20T11:00:00.000Z", true);
    const html = render({ ...cur, surface_breakdown: breakdown });

    for (const label of ["Claude Code", "Cowork", "Chats", "Other"]) expect(html).toContain(label);
    // 21 + 9 + 8 went somewhere the local index never looks.
    expect(html).toContain("outside Claude Code");
    expect(html).toContain("38%");
  });

  it("says nothing at all when the account did not report a split", () => {
    const html = render(current("2026-09-13T11:00:00.000Z", "2026-09-20T11:00:00.000Z", true));

    expect(html).not.toContain("outside Claude Code");
    expect(html).not.toContain("Cowork");
  });
});

describe("Claude status block and tabs", () => {
  const now = Date.now();
  const start = new Date(now - 55 * hour).toISOString();
  const reset = new Date(now + 17 * hour).toISOString();
  const read = new Date(now - 5 * 60_000).toISOString();
  const live: ClaudeCurrentWindow = {
    ...current(start, reset, true),
    elapsed_hours: 55, remaining_hours: 17, elapsed_percent: 76.39,
    spend: { calls: 9934, usd: 982.29, gross: 2_665_849_416, fresh: 7_017_557, unpriced_calls: 0 },
    percent_all_measured: 49, measured_at: read, projected_end_percent: 64.3, remaining_usd: 873.11,
    counter_reset: { reset_at: reset, last_before: { at: new Date(now - 72 * hour).toISOString(), percent: 88 }, first_after: { at: start, percent: 0 } },
  };
  const week: RailWindow = {
    key: "week", counterKey: "claude:weekly_all", counterLabel: "7d", label: "7d", dateLabel: "now", source: "probe",
    isCurrent: true, usedPercent: 49, percentBasis: "measured", elapsedPercent: 76.39, ppAhead: -27, windowHours: 168,
    startIso: start, resetIso: reset, regimeKey: "claude:weekly_all:max:segment",
    // 1 pp per hour for the last 24 h of readings.
    shape: [{ t: 0, pct: 0 }, { t: 30, pct: 20 }, { t: 43.03, pct: 25 }, { t: 76.2, pct: 49 }],
    sampledAtIso: read, sampleMachine: "EXAMPLE-MAIN",
    trafficByMachine: [{ machine: "EXAMPLE-MAIN", amount: 900 }, { machine: "LAPTOP-A", amount: 100 }],
    tokensTotal: null, usd: null, note: "Counter fell from 88% to 0%.", scope: null,
    sublimits: [{ counterKey: "claude:weekly_scoped:Fable", label: "Fable", usedPercent: 0, percentBasis: "measured", shape: null,
      regimeKey: "claude:weekly_scoped:Fable", sampledAtIso: read, sampleMachine: "EXAMPLE-MAIN", tokensTotal: null, usd: null, note: null }],
    counterSegment: { startDrop: { before: 88, after: 0 }, endDrop: null },
    accountMeters: {
      read_at: read,
      meters: [
        { key: "iguana_necktie", utilization_percent: 0, resets_at: new Date(now + 40 * 24 * hour).toISOString(), limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 },
        { key: "nimbus_quill", utilization_percent: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
      ],
      extra_usage: { enabled: false, user_disabled: true, spent_minor: 0, currency: "USD", exponent: 2 },
    },
  };
  const session: RailWindow = {
    ...week, key: "session", counterKey: "claude:session", counterLabel: "5h", label: "5h", windowHours: 5,
    usedPercent: 29, elapsedPercent: 30, startIso: new Date(now - 1.5 * hour).toISOString(), resetIso: new Date(now + 3.5 * hour).toISOString(),
    regimeKey: "claude:session", shape: [{ t: 10, pct: 5 }, { t: 30, pct: 29 }], sublimits: [], counterSegment: null, accountMeters: null,
  };
  const closedWeek: RailWindow = {
    ...week, key: "old", isCurrent: false, usedPercent: 64, percentBasis: "measured", startIso: new Date(now - 230 * hour).toISOString(),
    resetIso: new Date(now - 62 * hour).toISOString(), shape: null, tokensTotal: 3_627_179_308, usd: 3042.75,
    sublimits: [{ ...week.sublimits[0]!, usedPercent: 13 }], counterSegment: null, accountMeters: null, note: "Reconstructed window.",
  };
  const capacity = {
    reset_at: reset, weekly_capacity_tokens: { value: 4_528_220_840, absent: null }, weekly_capacity_api_usd: { value: 1711.98, absent: null },
    account_total_tokens: { value: 2_218_828_212, absent: null }, account_total_api_usd: { value: 838.87, absent: null },
    coverage: { assumptions: ["The share is treated as a share of tokens."] },
  } as unknown as ClaudeCodeCapacitySummary;
  const windows = [week, session, closedWeek];
  const sections = (overrides: Partial<ClaudeLimitResponse> = {}, rail = windows) => claudeSections({
    capabilities: null, account: "claude-main", windows: rail, insights: buildWindowInsights(rail, now),
    data: { ...report(live), plan: "max-20x", claude_code_capacity: capacity, probe: { ...report(live).probe, weekly_resets_at: reset }, ...overrides },
  });

  it("keeps grant, extra-usage observations and local API-eq separate without inventing funded calls", () => {
    const extra = (used: number) => ({
      "claude.raw.iguana_necktie.limit_dollars": 250, "claude.raw.iguana_necktie.used_dollars": used,
      "claude.raw.iguana_necktie.remaining_dollars": 250 - used, "claude.raw.iguana_necktie.resets_at": "2026-11-05T12:00:00Z",
      "claude.raw.extra_usage.is_enabled": true, "claude.raw.spend.used.amount_minor": 1250,
      "claude.raw.spend.limit.amount_minor": 5000, "claude.raw.spend.used.exponent": 2,
    });
    const observations = [{ ts: start, pools: decodeCreditPools("claude", extra(240)) },
      { ts: read, pools: decodeCreditPools("claude", extra(250)) }];
    const creditPools = creditPoolsInRange(observations, Date.parse(start), Date.parse(reset))!;
    const rail = [{ ...week, creditPools }, session];
    for (const language of ["en", "pl"] as const) {
      setLanguage(language);
      const html = renderToStaticMarkup(<VendorOverview sections={sections({}, rail)} />);
      const strip = html.match(/<div data-credit-strip[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(strip).toContain('data-pool-kind="grant"');
      expect(strip).toContain('data-pool-kind="purchase"');
      expect(strip).toContain(language === "en" ? "granted $250.00 · used $250.00 · left $0.00" : "przyznano $250,00 · zużyto $250,00 · zostało $0,00");
      expect(strip).toContain(language === "en" ? "limit $50.00 · used $12.50 · left $37.50" : "limit $50,00 · zużyto $12,50 · zostało $37,50");
      expect(html).toContain(language === "en" ? "$982.29" : "$982,29");
      expect(html).toContain(language === "en" ? "call funding" : "finansowanie wywołań");
      expect(html).toContain(language === "en" ? "not established" : "nieustalone");
      expect(html).toContain(language === "en" ? "grant · this window" : "grant · to okno");
      expect(html).toContain(language === "en" ? "$10.00" : "$10,00");
      expect(html).not.toContain("$ limit");
      expect(html).not.toContain("iguana_necktie, nimbus_quill");
      expect(html).not.toContain("data-credit-share");
      expect(html).not.toContain("from credits");
      expect(html).toContain("data-pool-usage-chart");
      expect(html).toContain('data-pool-series="claude:iguana_necktie" data-pool-basis="observed"');
      expect(html.match(/<svg viewBox=/g)).toHaveLength(1);
    }
  });

  it("draws when and how much the grant funded from its calls, in place of the bare account readings", () => {
    const extra = (used: number) => ({ "claude.raw.iguana_necktie.limit_dollars": 250, "claude.raw.iguana_necktie.used_dollars": used,
      "claude.raw.iguana_necktie.remaining_dollars": 250 - used, "claude.raw.iguana_necktie.resets_at": "2026-11-05T12:00:00Z" });
    const creditPools = creditPoolsInRange([{ ts: start, pools: decodeCreditPools("claude", extra(20)) },
      { ts: read, pools: decodeCreditPools("claude", extra(250)) }], Date.parse(start), Date.parse(reset))!;
    const hourAt = (h: number) => new Date(Math.floor((now - h * hour) / hour) * hour).toISOString();
    const funded: ClaudeCurrentWindow = { ...live, credit_funded: { calls: 1875, tokens: 400_000_000, credits: 0, credits_unpriced: 1875,
      api_standard: 236.19, api_unpriced: 0, first: hourAt(30), last: hourAt(28),
      hours: [[hourAt(30), 1000, 200_000_000, 0, 120], [hourAt(29), 875, 200_000_000, 0, 116.19]] } };
    setLanguage("pl");
    const html = renderToStaticMarkup(<VendorOverview sections={sections({ current: funded }, [{ ...week, creditPools }, session])} />);
    expect(html).toContain('data-pool-series="claude:iguana_necktie" data-pool-basis="funded"');
    expect(html).not.toContain('data-pool-series="claude:iguana_necktie" data-pool-basis="observed"');
    // "%": $236.19 of the window's ≈ $2 004.67 at 100% ($982.29 at 49%).
    expect(html).toContain("grant · wycena wywołań z puli · ≈ 12%");
    expect(html).toContain("grant ≈ $236,19");
    expect(html).not.toContain("z kredytów (po 100%)");
    expect(html).not.toContain("opłacone kredytami");
    expect(html).not.toContain("nieustalone");
  });

  describe("a closed counter segment picked in the rail", () => {
    const segStart = new Date(now - 200 * hour).toISOString();
    const segEnd = new Date(now - 105 * hour).toISOString();
    const segment = (patch: Partial<RailWindow>): RailWindow => ({
      ...week, key: "seg", isCurrent: false, startIso: segStart, resetIso: segEnd, plan: "max-5x", accountMeters: null,
      shape: [{ t: 10, pct: 25 }, { t: 60, pct: 70 }, { t: 81.6, pct: 88 }], counterSegment: { startDrop: null, endDrop: { before: 88, after: 0 } },
      ...patch,
    });
    // The server reports exactly the segment's bounds; the percentage comes from the rail.
    const bounded: ClaudeCurrentWindow = { ...current(segStart, segEnd, false), elapsed_hours: 95, elapsed_percent: 100 };
    const render = (window: RailWindow) => renderToStaticMarkup(<VendorOverview sections={claudeSections({
      capabilities: null, account: "claude-main", windows: [window, week, session], selectedHistorical: true,
      insights: buildWindowInsights([window, week, session], now, "seg"),
      data: { ...report(bounded), plan: "max-20x" },
    })} />);

    it("names the plan period of the segment and its manual 100% reading", () => {
      const read = new Date(now - 117 * hour).toISOString();
      const html = render(segment({ usedPercent: 100, percentBasis: "manual", sampledAtIso: read, sampleMachine: null,
        shape: [{ t: 10, pct: 25 }, { t: 81.6, pct: 88 }, { t: 87.4, pct: 100 }] }));
      // A closed window keeps its own plan; state and account are in the context bar and the picker.
      expect(html).toContain('<span class="sub-card-plan">Max · ×5</span>');
      expect(html).not.toContain("· closed · claude-main");
      expect(html).toContain("≈ manual reading 100%");
      expect(html).toContain("Window result");
      expect(html).not.toContain("no percentage for this window");
      expect(html).not.toContain("unread until the end");
    });

    it("warns when no reading covers the end of a window below 100%", () => {
      const read = new Date(now - 122.5 * hour).toISOString();
      const html = render(segment({ usedPercent: 88, percentBasis: "measured", sampledAtIso: read }));
      expect(html).toContain("% read");
      expect(html).toContain("last reading 88%");
      expect(html).toContain("17h 30m unread until the end");
    });
  });

  it("shows the live window's limit refusal logged after the last account reading", () => {
    const refusedAt = new Date(now - 60_000).toISOString();
    const rail = [{ ...week, usedPercent: 100, sampledAtIso: refusedAt, shape: [...week.shape!, { t: 76.39, pct: 100 }] }, session, closedWeek];
    const html = renderToStaticMarkup(<VendorOverview sections={sections({}, rail)} />);
    expect(html).toContain('<div class="mono" style="font-size:var(--fs-3);color:var(--faint)"><span title=');
    expect(html).toContain('">% read ');
    expect(html).toContain(">100<");
    expect(html).not.toContain(">49<");
  });

  it("shows every account counter, the plan-change drop and this window's traffic in one block", () => {
    const html = renderToStaticMarkup(<VendorOverview sections={sections()} />);
    // Plan, state and account of the live window are in the picker and the context bar above.
    expect(html).not.toContain("· current · claude-main");
    expect(html).toContain("5h session");
    expect(html).toContain("7d week");
    expect(html).toContain("↳ Fable");
    expect(html).toContain("as 7d");
    expect(html).toContain("$ limit");
    expect(html).toContain("$0 / $250");
    expect(html).toContain("iguana_necktie, nimbus_quill · meaning unconfirmed");
    expect(html).toContain("Extra usage");
    expect(html).toContain("turned off by the user");
    expect(html).toContain("7d counter 88% → 0% · plan change");
    expect(html).toContain("left 51% ≈ $873.11 API-eq");
    expect(html).toContain("EXAMPLE-MAIN 90%");
    expect(html).toContain("cache 100%");
    // No daily traffic in Claude's report: the chart draws no token bars.
    expect(html).not.toContain("tokens / day");
    // The old hero, KPI strip, next-reset and burn cards are gone.
    expect(html).not.toContain("Next reset");
    expect(html).not.toContain("Burn rate vs remaining time");
    expect(html).not.toContain("cycle health");
  });

  it("marks a computed percentage as an estimate in the counters and the header", () => {
    const estimated = { ...week, percentBasis: "counterfactual" as const, source: "declared" as const, sampledAtIso: null };
    const html = renderToStaticMarkup(<VendorOverview sections={sections({
      current: { ...live, percent_all_measured: null, percent_all_est: 49, measured_at: null },
    }, [estimated, session])} />);
    expect(html).toContain("≈49%");
    expect(html).toContain("estimate");
    expect(html).toContain("computed percentage");
  });

  it("budgets the window in %, tokens and API-eq from the shared estimate and reads recent pace from the course", () => {
    const html = renderToStaticMarkup(<VendorOverview sections={sections()} />);
    expect(html).toContain("≈ 2.22B");
    expect(html).toContain("≈ 2.31B");
    expect(html).toContain("≈ $838.87");
    expect(html).toContain("100% ≈ 4.53B tokens · $1,711.98 API-eq");
    expect(html).not.toContain("credits");
    expect(html).toContain(">24h<");
    expect(html).toContain("1 pp/h");
    expect(html).toContain("lasts until reset: 3 pp/h");
  });

  it("lists the weekly windows in the history tab, newest first, without inventing missing values", () => {
    const html = renderToStaticMarkup(<>{sections().history}</>);
    expect(html).toContain("Weekly windows");
    expect(html).toContain("2 windows");
    expect(html).toContain("↓ after plan change");
    expect(html).toContain("3.63B");
    expect(html).toContain("$3,042.75");
    expect(html).toContain('title="Reconstructed window."');
    expect(html.indexOf("after plan change")).toBeLessThan(html.indexOf("3.63B"));
  });
});
