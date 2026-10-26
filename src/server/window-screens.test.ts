import { expect, test } from "bun:test";
import type { AppContext } from "./api";
import { cacheKey } from "./cache";
import { prefillRequests, WINDOW_SCREENS } from "./window-screens";
import { emptySeries } from "../web/lib/cycle";
import type { ApiCycle, WindowsResponse } from "../web/lib/api";

/**
 * Prefill (window-screens.ts `prefill`, data-read.ts): the requests every window screen makes when it is first
 * opened, for every declared subscription and window, as the web client builds them.
 */
// The current week started two days ago: its history reaches today.
const hour = 3_600_000, start = Math.floor(Date.now() / hour) * hour - 48 * hour;
const iso = (ms: number) => new Date(ms).toISOString();

test("30-day capacity corrections outside the visible days invalidate only the matching scope", () => {
  const request = (minutes: number) => new URL(`http://local/api/codex-accounting?account=free&since=2026-10-19&until=2026-10-19&window_minutes=${minutes}`);
  const monthly = WINDOW_SCREENS["/api/codex-accounting"]!.scope(request(43200), {} as AppContext)!;
  const weekly = WINDOW_SCREENS["/api/codex-accounting"]!.scope(request(10080), {} as AppContext)!;
  expect(monthly.fromMs).toBeLessThan(Date.parse("2026-09-20"));
  expect(weekly.fromMs).toBeGreaterThan(Date.parse("2026-09-20"));
  expect(monthly.family).not.toBe(weekly.family);
});
function cycle(index: number, from: number, active: boolean, overrides: Partial<ApiCycle> = {}): ApiCycle {
  return {
    index, limit_id: "codex", label: "w", anchor: (from + 168 * hour) / 1000,
    resets_at_iso: iso(from + 168 * hour), window_start_iso: iso(from),
    start_ts: iso(from + 10 * hour), end_ts: iso(from + 50 * hour), work_from_ts: iso(from), work_to_ts: iso(from + 168 * hour),
    is_active: active, shadow: false, status: active ? "active" : "closed", sample_count: 100, lag_fraction: 0, distinct_steps: 40,
    first_percent: 20, peak_percent: 60, end_percent: 60, hit_100: false, window_hours: 168, elapsed_hours: 55,
    observed_hours: 40, remaining_hours: 113, pace_percent_per_day: 26, projected_end_percent: 183,
    eta_100_iso: null, calls: 100, usd: 800, usd_per_percent: 13.33, usd_at_100_percent: 1333,
    tokens: { in: 7000, cached_in: 5000, out: 1000, cache_write: 0, reasoning: 0, total: 8000 },
    top_model: "model", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
    ...overrides,
  } as ApiCycle;
}
const ctx = { accounts: { version: 2, sources: [], subscriptions: [
  { id: "codex1", vendor: "codex" }, { id: "claude-a", vendor: "claude" }, { id: "grok-x", vendor: "grok" },
] } } as unknown as AppContext;
const windows: WindowsResponse = { account: "claude-a", provider: "claude", source: "probe", windows: [
  { key: "now", isCurrent: true, startIso: iso(start + 168 * hour), resetIso: iso(start + 336 * hour) },
  { key: "w1", isCurrent: false, startIso: iso(start), resetIso: iso(start + 168 * hour) },
  { key: "s1", isCurrent: false, startIso: iso(start + 200 * hour), resetIso: iso(start + 205 * hour) },
] as WindowsResponse["windows"] };
const series = emptySeries("codex1", 10080, [cycle(1, start - 168 * hour, false), cycle(2, start, true)]);
const stored = (url: URL): unknown => url.pathname === "/api/usage-series" && url.searchParams.get("window") === "10080" ? series
  : url.pathname === "/api/windows" && url.searchParams.get("account") === "claude-a" ? windows : null;

test("rails first, then current windows, then closed windows newest first, each request once", () => {
  const list = prefillRequests(ctx, stored);
  const keys = list.map(item => item.key);
  expect(new Set(keys).size).toBe(keys.length);
  const orders = list.map(item => item.order);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));
  // Rails: the independent Codex meters, every subscription's windows and Claude's live window.
  expect(list.filter(item => item.order === 0).map(item => item.key).sort()).toEqual([
    "/api/claude-limit-card?account=claude-a",
    "/api/usage-series?account=codex1&points=900&window=10080", "/api/usage-series?account=codex1&points=900&window=300",
    "/api/usage-series?account=codex1&points=900&window=43200",
    "/api/windows?account=claude-a", "/api/windows?account=codex1", "/api/windows?account=grok-x",
  ]);
  const closed = list.filter(item => item.order === 2);
  expect(closed.map(item => item.endMs)).toEqual([...closed.map(item => item.endMs)].sort((a, b) => b - a));
});

test("default accounting prefill matches the frontend's inclusive 30-day range", () => {
  const report = prefillRequests(ctx, stored).find(item => item.url.pathname === "/api/codex-accounting" && item.order === 3)!;
  const since = Date.parse(report.url.searchParams.get("since")!), until = Date.parse(report.url.searchParams.get("until")!);
  expect((until - since) / 86400000 + 1).toBe(30);
});

test("a Codex window's requests are the Overview's: breakdown, paired observation, history sample and accounting", () => {
  const list = prefillRequests(ctx, stored), codex = (path: string) => list.filter(item => item.url.pathname === path);
  const key = (params: Record<string, string>) => cacheKey(new URL(`/api/cycle-breakdown?${new URLSearchParams(params)}`, "http://local"));
  const current = codex("/api/cycle-breakdown").filter(item => item.order === 1);
  expect(current.map(item => [item.key, item.moving]).sort()).toEqual([
    [key({ account: "codex1", since_ts: iso(start), until_ts: iso(start + 168 * hour), anchor: String((start + 168 * hour) / 1000),
      limit_id: "codex", valuation: "dated" }), false],
    [key({ account: "codex1", limit_id: "codex", anchor: String((start + 168 * hour) / 1000), since_ts: iso(start + 10 * hour + 1),
      until_ts: iso(start + 50 * hour), end_inclusive: "true", valuation: "dated" }), true],
  ].sort());
  // The closed week: its breakdown (the history sample's URL is the same here) and its paired observation.
  expect(codex("/api/cycle-breakdown").filter(item => item.order === 2).map(item => item.moving)).toEqual([false, false]);
  // The weekly history of the current window reaches today and moves; the closed window's ends at its reset.
  const accounting = codex("/api/codex-accounting");
  expect(accounting.find(item => item.order === 1)?.moving).toBe(true);
  expect(accounting.find(item => item.order === 2)?.key).toBe(`/api/codex-accounting?account=codex1&since=${iso(start - 168 * hour).slice(0, 10)}`
    + `&until=${iso(start).slice(0, 10)}`);
  expect(accounting.filter(item => item.order === 3).map(item => item.moving)).toEqual([true]);
});

test("Claude's closed rail windows are prefilled with their bounds; other providers' range screens with the default days", () => {
  const list = prefillRequests(ctx, stored);
  expect(list.filter(item => item.url.pathname === "/api/claude-limit-card" && item.order === 2).map(item => item.key)).toEqual([
    cacheKey(new URL(`/api/claude-limit-card?account=claude-a&from=${iso(start + 200 * hour)}&until=${iso(start + 205 * hour)}`, "http://local")),
    cacheKey(new URL(`/api/claude-limit-card?account=claude-a&from=${iso(start)}&until=${iso(start + 168 * hour)}`, "http://local")),
  ]);
  const ranges = list.filter(item => item.url.pathname === "/api/subscription-accounting");
  expect(ranges.map(item => item.url.searchParams.get("provider")).sort()).toEqual(["claude", "grok"]);
  expect(ranges.every(item => item.moving && item.order === 3)).toBe(true);
  // Nothing derived from a rail that is not stored yet.
  expect(prefillRequests(ctx, () => null).some(item => item.order === 1 || item.order === 2)).toBe(false);
});
