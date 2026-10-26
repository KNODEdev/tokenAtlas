import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "./Analytics";
import { History } from "./History";
import { Insights, insightsScope } from "./Insights";
import { Patterns, activityRequest } from "./Patterns";
import { Sidebar } from "../components/Sidebar";
import { api, type ApiAccount, type ApiCycle } from "../lib/api";
import * as asyncState from "../lib/useAsync";
import { buildModel, emptyModel, emptySeries, type AtlasModel } from "../lib/cycle";
import { setLanguage } from "../lib/i18n";
import { screenLabel, screenTitle, type ScreenId, type ScreenProps } from "../lib/screens";

function props(model: AtlasModel, patch: Partial<ScreenProps> = {}): ScreenProps {
  const noop = () => {};
  return { model, account: "codex1", unit: "percent", setUnit: noop, selectAccount: noop,
    accounts: [], capabilities: null, card: null, project: "", setProject: noop, projects: [],
    chosen: null, selectCycle: noop, openDrawer: noop, windowRailInShell: false, goto: noop,
    compare: [], setCompare: noop, sync: null, triggerSync: noop, ...patch };
}

const DAY = 86_400_000;
function cycle(index: number, allowance: number, span: number, plan = "pro"): ApiCycle {
  const from = Date.parse("2026-07-01T00:00:00Z") + index * 7 * DAY;
  return {
    index, limit_id: "codex", label: new Date(from).toISOString().slice(0, 10), anchor: null,
    resets_at_iso: new Date(from + 7 * DAY).toISOString(), window_start_iso: new Date(from).toISOString(),
    is_active: false, shadow: false, status: "reset", start_ts: new Date(from).toISOString(), end_ts: new Date(from + 7 * DAY).toISOString(),
    work_from_ts: new Date(from).toISOString(), work_to_ts: new Date(from + 7 * DAY).toISOString(),
    sample_count: 200, lag_fraction: span >= 80 ? 0 : 0.3, distinct_steps: span >= 80 ? 80 : 5, first_percent: 0, peak_percent: span, end_percent: span,
    hit_100: span >= 100, window_hours: 168, elapsed_hours: 168, observed_hours: 168, remaining_hours: null, pace_percent_per_day: 1,
    projected_end_percent: null, eta_100_iso: null, calls: 1, usd: 1, usd_per_percent: null, usd_at_100_percent: null,
    tokens: { in: 0, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: (allowance * span) / 100 },
    top_model: "gpt", source_models: [], model_usage: [], surface_usage: [], plan_types: [plan], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
  };
}

test("analytics safely evaluates its hooks with an empty model", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<Analytics {...props(emptyModel("codex1", 10080))} />);
  expect(html).toContain("No analytics data");
  expect(html).not.toContain("NaN");
});

test("analytics reports the canonical allowance median, not the median of every estimate", () => {
  // Reliable 1B / 2B / 3B windows of Pro; two low-confidence estimates would pull an all-windows median to 2.5B.
  const model = buildModel(emptySeries("codex1", 10080, [
    cycle(0, 0.1e9, 100, "plus"), cycle(1, 1e9, 100), cycle(2, 90e9, 30), cycle(3, 2e9, 100), cycle(4, 100e9, 30), cycle(5, 3e9, 90),
  ]));
  try {
    for (const language of ["en", "pl"] as const) {
      setLanguage(language);
      const html = renderToStaticMarkup(<Analytics {...props(model)} />);
      expect(html).not.toContain("NaN");
      expect(html).toContain(language === "en" ? "median of 3 reliable windows" : "mediana 3 wiarygodnych okien");
      expect(html).not.toContain("#1<"); // no per-bar "#N" labels under the bars
    }
    setLanguage("en");
    const html = renderToStaticMarkup(<Analytics {...props(model)} />);
    expect(html).toMatch(/Full allowance · est\.<\/div><div[^>]*>2B</);
    expect(html).toMatch(/<text[^>]*>07\/\d{2}<\/text>/); // calendar days on the window axis
    expect(html).toContain("low confidence");
  } finally { setLanguage("en"); }
});

test("the patterns heatmap asks for the selected subscription", async () => {
  expect(activityRequest("codex2", "")).toEqual({ account: "codex2", project_id: undefined });
  expect(activityRequest("codex1", "tokenatlas")).toEqual({ account: "codex1", project_id: "tokenatlas" });
  const loads: Array<(signal: AbortSignal) => Promise<unknown>> = [];
  const state = spyOn(asyncState, "useAsync").mockImplementation(((fn: (signal: AbortSignal) => Promise<unknown>) => {
    loads.push(fn);
    return { data: null, loading: true, error: null, reload() {} };
  }) as typeof asyncState.useAsync);
  const activity = spyOn(api, "activity").mockResolvedValue({} as Awaited<ReturnType<typeof api.activity>>);
  try {
    renderToStaticMarkup(<Patterns {...props(emptyModel("codex2", 10080), { account: "codex2" })} />);
    expect(loads).toHaveLength(1);
    await loads[0]!(new AbortController().signal);
    expect(activity.mock.calls[0]![0]).toEqual({ account: "codex2", project_id: undefined });
  } finally {
    state.mockRestore();
    activity.mockRestore();
  }
});

test("Trends and Patterns are views of Limits → Limit windows: one menu entry, one title (IA-2026-10-19 v1.1)", () => {
  setLanguage("en");
  for (const screen of ["analytics", "patterns"] as ScreenId[]) {
    const nav = renderToStaticMarkup(<Sidebar screen={screen} goto={() => {}} collapsed={false} onToggleCollapse={() => {}} status={{ lastSync: null, calls: null, live: false }} />);
    expect(nav).toContain('aria-current="page" class="shell-nav-item"><span class="shell-nav-icon">%</span><span>Limits</span>');
    expect(nav).not.toContain("Patterns");
    expect(screenTitle(screen, "en")).toBe("Limits");
  }
  // The command palette can still open the Patterns view directly.
  expect(screenLabel("patterns", "en")).toBe("Limits › Limit windows › Patterns");
  const opened: ScreenId[] = [];
  const claude: ApiAccount = { id: "claude-max", vendor: "claude", plan: "max", login: null, machine: null, note: null, homes: [],
    ratelimit_rows: 0, event_rows: 0, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: false, has_events: true };
  const html = renderToStaticMarkup(<Insights {...props(emptyModel("claude-max", 10080), { account: "claude-max", accounts: [claude], goto: (s) => opened.push(s) })} tab="patterns" cards={[]} />);
  expect(html).toContain('aria-selected="true"');
  expect(html).toMatch(/id="insights-tab-patterns"[^>]*aria-selected="true"/);
  expect(html).toContain("Analytics and patterns cover Codex cycles for now.");
});

test("the screen tells Claude, Business and All apart from cycle accounts", () => {
  const account = (id: string, vendor: string, plan: string | null = null) => ({ id, vendor, plan }) as ApiAccount;
  expect(insightsScope({ account: "__all__", accounts: [], card: null })).toBe("all");
  expect(insightsScope({ account: "claude-max", accounts: [account("claude-max", "claude")], card: null })).toBe("claude");
  expect(insightsScope({ account: "codex1::business", accounts: [account("codex1::business", "codex")], card: null })).toBe("credits");
  expect(insightsScope({ account: "biz", accounts: [account("biz", "codex", "self_serve_business_usage_based")], card: null })).toBe("credits");
  expect(insightsScope({ account: "codex2", accounts: [account("codex2", "codex", "plus")], card: null })).toBe("cycles");
  setLanguage("en");
  const business = renderToStaticMarkup(<Insights {...props(emptyModel("codex1::business", 10080), { account: "codex1::business", accounts: [account("codex1::business", "codex")] })} tab="analytics" cards={[]} />);
  expect(business).toContain("Business is billed in credits.");
  expect(business).not.toContain("No analytics data");
});


test("Codex history names successive dates on the window axis and keeps full instants in tooltips", () => {
  setLanguage("en");
  const model = buildModel(emptySeries("codex1", 10080, [cycle(0, 1e9, 100), cycle(1, 1e9, 100), cycle(2, 1e9, 100)]));
  const html = renderToStaticMarkup(<History {...props(model)} />);
  expect(html).toMatch(/<text[^>]*>07\/01<\/text>/);
  expect(html).toMatch(/<text[^>]*>07\/08<\/text>/);
  expect(html).toContain("2026-07-01T00:00:00.000Z");
  expect(html).not.toMatch(/<text[^>]*>#[0-9]+<\/text>/);
});
