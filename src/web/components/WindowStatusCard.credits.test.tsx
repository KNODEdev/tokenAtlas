import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiCycle, CycleBreakdownResponse } from "../lib/api";
import { buildCycleView } from "../lib/cycle";
import { accountCreditsOfCycles } from "../lib/credit-pools-view";
import { setLanguage } from "../lib/i18n";
import { localDayKey } from "../../shared/credit-funded";
import { CapacityRow, WindowStatusCard } from "./WindowStatusCard";

// Mockup 2 (accepted 10.10) on the Overview window block: the strip, the chart's unit switch and credit segments,
// the "Window result" caption and the "Credits in this window" section; nothing of it for an account without credits.
const hour = 3_600_000;
const start = Date.parse("2026-09-26T18:00:00Z");
const iso = (hours: number) => new Date(start + hours * hour).toISOString();
afterEach(() => setLanguage("en"));

function cycle(overrides: Partial<ApiCycle> = {}) {
  const view = buildCycleView({
    index: 60, limit_id: "codex", label: "Sep 26", anchor: (start + 168 * hour) / 1000,
    resets_at_iso: iso(168), window_start_iso: iso(0), start_ts: iso(1), end_ts: iso(160),
    work_from_ts: iso(0), work_to_ts: iso(160), is_active: false, shadow: false, status: "closed", sample_count: 300, lag_fraction: 0,
    distinct_steps: 90, first_percent: 1, peak_percent: 100, end_percent: 100, hit_100: true, window_hours: 168, elapsed_hours: 160,
    observed_hours: 159, remaining_hours: 0, pace_percent_per_day: 15, projected_end_percent: null, eta_100_iso: null, calls: 28310,
    usd: 2065.4, usd_per_percent: 20.65, usd_at_100_percent: 2065.4,
    tokens: { in: 4.7e9, cached_in: 4.6e9, out: 0.08e9, cache_write: 0, reasoning: 0, total: 4.78e9 },
    top_model: "gpt-6", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
    ...overrides,
  }, []);
  view.number = 60;
  return view;
}
const credits = {
  point_basis: { start: iso(0), end: iso(100), windowStart: iso(0), windowHours: 168, plan: "pro", percent: 100,
    usd: 2065.4, credits: 39061.54, tokens: 4.78e9, partial: false },
  credits: { standard: 39061.54, unpriced_calls: 0 },
  at_limit: { ts: iso(84), percent: 100, events: 25000, tokens: 4.78e9, api_standard: 2065.4, api_unpriced: 0, credits: 39061.54, credits_unpriced: 0,
    joint_api_standard: 2065.4, joint_credits: 39061.54 },
  credit_funded: { calls: 3127, tokens: 549e6, credits: 4500, credits_unpriced: 0, api_standard: 238, api_unpriced: 0,
    first: iso(110), last: iso(140), hours: [[iso(110), 2000, 270e6, 2200, 116], [iso(140), 1127, 279e6, 2300, 122]] as Array<[string, number, number, number, number]> },
  credit_pools: { read_at: "2026-10-10T07:31:00.000Z", flows: [],
    pools: [{ key: "codex:credits", kind: "balance" as const, unit: "credits" as const, granted: null, used: null, remaining: 60749.9557035,
      remaining_text: "60749.9557035000", unlimited: false, granted_at: null, expires_at: null, items: null }] },
} satisfies Partial<ApiCycle>;
const totals = (c: ReturnType<typeof cycle>): CycleBreakdownResponse => ({ account: "codex1", since_ts: iso(0), until_ts: iso(168), limit_id: "codex",
  session_window_minutes: 300, bucketing: "local time", dow_origin: "monday", short_counter: { reported: false, last_reported_ts: null, live: null, other: [] },
  burn_windows: [], note: null, totals: { calls: c.calls, usd: c.usd, tokens: c.tokensTotal, tokens_fresh: 1e8 }, unpriced: { tokens: 0, models: {} },
  days: [0, 24, 48, 72].map(h => ({ date: localDayKey(start + h * hour), tokens: 1e9, usd: 400, calls: 5000, tokens_fresh: 1e7, dow: 0, from_ts: iso(h),
    to_ts: iso(h + 24), hours: 24, top_model: null, gauge_end: null, gauge_delta: null, gauge_samples: 0, is_today: false })),
  sessions: [0, 42, 84, 126].map(h => ({ index: h / 42, start_ts: iso(h), end_ts: iso(h + 42), active: false, calls: 100, tokens: 1.2e9, tokens_fresh: 1e7,
    usd: 516, credits: 9765, top_model: null, reported_percent: null, reported_samples: 0, reported_reset_ts: null })),
});
const render = (c: ReturnType<typeof cycle>, withTotals = true) => renderToStaticMarkup(<WindowStatusCard cycle={c} insights={[]} account="codex1"
  totals={withTotals ? totals(c) : null} loading={false} error={null} remainingTokens={null} dailyMedian={null} ownershipGap={null}
  accountCredit={accountCreditsOfCycles([c])} />);

describe("window block with credits", () => {
  it("adds the strip, the caption, the credit segments and the section for a window paid on from credits", () => {
    setLanguage("pl");
    const html = render(cycle(credits));
    expect(html).toContain("data-credit-strip");
    expect(html).toContain('data-pool="codex:credits"');
    expect(html).toContain("zostało 60 749,96 kr.");
    expect(html).toContain("≈ 1,6 okna");
    expect(html).toContain("potem +11% okna z kredytów");
    expect(html).toContain("z kredytów (po 100%)");
    expect(html).not.toContain("→ dalej z kredytów");
    expect(html).toContain("data-pool-usage-chart");
    expect(html).toContain('data-pool-series="codex:credits" data-pool-basis="funded"');
    // The credit rows close "To okno" without a heading or the strip's figures.
    expect(html).not.toContain("Kredyty w tym oknie");
    expect(html).toContain("z kredytów</span>");
    expect(html).toContain("3127");
    // The earlier "from pool" row is replaced, not shown beside the section.
    expect(html).not.toContain(">z puli</span>");
    // The unit switch, "%" by default.
    expect(html).toMatch(/<button type="button" class="mono ui-tab" title="Licznik dostawcy" aria-pressed="true">%<\/button>/);
    expect(html).toContain(">kredyty</button>");
  });

  it("an account without credits keeps the block as it was, apart from the unit switch", () => {
    setLanguage("pl");
    const html = render(cycle());
    for (const marker of ["data-credit-strip", "data-window-credits", "data-credit-share", "z kredytów", "var(--violet)"])
      expect(html).not.toContain(marker);
    expect(html).toContain("ui-tab");
  });
  it("states the capacity at 100% in dollars and credits, against the account's conversion window", () => {
    setLanguage("pl");
    const html = renderToStaticMarkup(<CapacityRow percent={29}
      usdCapacity={{ value: 1180.93, estimate: true, partial: true, range: { low: 1140.2, high: 1223.1 } }}
      creditCapacity={{ value: 27205.6, estimate: true, partial: false, range: { low: 26302.1, high: 28177.2 } }}
      basis={{ number: 7, credits: 30065 }} />);
    expect(html).toContain("na 100%");
    expect(html).toContain("≥ $1181");
    expect(html).toContain("$1140–$1223 · 26 302–28 177 kr.\"");
    expect(html).toContain("≈ 27 206 kr.");
    expect(html).toContain("okno #7: 30 065 kr.");
    expect(html).toContain("−10%");
    expect(html).toContain("29% licznika");
    // The conversion window itself reached the limit: its own row is measured and has nothing to compare with.
    const own = renderToStaticMarkup(<CapacityRow percent={100} usdCapacity={{ value: 2065.4, estimate: false, partial: false, range: null }}
      creditCapacity={null} basis={null} />);
    expect(own).toContain("$2065");
    expect(own).not.toContain("≈");
  });
});
