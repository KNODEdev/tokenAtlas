import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiCycle, ApiPoint } from "../lib/api";
import { buildModel, emptySeries } from "../lib/cycle";
import { getLocale, setLanguage, type Language } from "../lib/i18n";
import type { ScreenProps } from "../lib/screens";
import { Compare, usageAtHours } from "./Compare";
import { History } from "./History";

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

const HOUR = 3_600_000;
const START = Date.parse("2026-08-01T00:00:00.000Z");

/** Cycle `index` starts a week after the previous one; `hours` is how long it lasted. */
function cycle(index: number, peak: number, hours: number, active = false): ApiCycle {
  const from = START + (index - 1) * 168 * HOUR;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    index, label: iso(from).slice(0, 10), anchor: (from + 168 * HOUR) / 1000, resets_at_iso: iso(from + 168 * HOUR), window_start_iso: iso(from),
    is_active: active, shadow: false, status: active ? "live" : "closed", start_ts: iso(from), end_ts: iso(from + hours * HOUR),
    work_from_ts: iso(from), work_to_ts: iso(from + hours * HOUR), sample_count: 60, lag_fraction: 0, distinct_steps: 40,
    first_percent: 0, peak_percent: peak, end_percent: peak, hit_100: peak >= 100, window_hours: 168, elapsed_hours: hours,
    observed_hours: hours, remaining_hours: active ? 168 - hours : null, pace_percent_per_day: 0, projected_end_percent: null, eta_100_iso: null,
    calls: 10, usd: 100 * index, usd_per_percent: null, usd_at_100_percent: null,
    tokens: { in: 1_000_000, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: 1_000_000 * index },
    top_model: index < 3 ? "gpt-5.5" : "gpt-6", source_models: [], model_usage: [], surface_usage: [], plan_types: ["pro"], limit_names: [],
    delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
  };
}
/** Readings rising linearly from 0 to `peak` over `hours`. */
function readings(c: ApiCycle): ApiPoint[] {
  return [0, 0.5, 1].map((share) => {
    const hours = c.elapsed_hours * share;
    return {
      ts: new Date(Date.parse(c.work_from_ts) + hours * HOUR).toISOString(), ts_last: "", cycle: c.index,
      percent: c.peak_percent * share, percent_min: 0, percent_last: 0, samples: 1, cycle_progress: (hours / 168) * 100,
    };
  });
}

function props(): ScreenProps {
  // #1 unused (full week, 40%), #2 exhausted, #3 reset early at 20%, #4 current.
  const cycles = [cycle(1, 40, 168), cycle(2, 100, 48), cycle(3, 20, 30), cycle(4, 12, 24, true)];
  const series = { ...emptySeries("codex1", 10080, cycles), points: cycles.flatMap(readings) };
  return {
    model: buildModel(series), unit: "percent", setUnit: () => {}, account: "codex1", selectAccount: () => {}, accounts: [], capabilities: null,
    card: null, project: "", setProject: () => {}, projects: [], chosen: null, selectCycle: () => {}, openDrawer: () => {},
    windowRailInShell: false, goto: () => {}, compare: [], setCompare: () => {}, sync: null, triggerSync: () => {},
  };
}

describe("usage at the same hour since start", () => {
  it("reads between readings, and a window that is over at its end", () => {
    const course = [[0, 0], [10, 50], [20, 80]] as const;
    expect(usageAtHours(course, 20, 80, 5)).toEqual({ value: 25, exact: false });
    expect(usageAtHours(course, 20, 80, 30)).toEqual({ value: 80, exact: true });
    expect(usageAtHours([[5, 10], [8, 20]], null, 20, 2)).toBeNull();
  });
});

describe("Compare (Codex cycles)", () => {
  it("shows one comparison on an hour axis with the current window and the three newest closed ones", () => {
    const html = renderToStaticMarkup(<Compare {...props()} />);
    expect(html).toContain("Usage since window start");
    expect(html).toContain(">7d<");
    expect(html).toContain("At the same moment - 1d 00h from start");
    expect(html).toContain("in progress");
    expect(html).toContain("100% after 2d 00h");
    expect(html).toContain("typically");
    expect(html).toContain("median of 3 windows");
    expect(html).not.toContain("Building comparison material");
    expect(html.match(/<polyline/g)?.length).toBe(5);
  });
});

describe("History (Codex cycle archive)", () => {
  it("shows tiles, one bar per window and a table that tells an unused window from an early reset", () => {
    const html = renderToStaticMarkup(<History {...props()} />);
    expect(html).toContain("Typical end");
    expect(html).toContain("Exhausted");
    expect(html).toContain("one definition: ≥ 100%");
    expect(html).toContain("Each window");
    expect(html).toContain("reset early 1");
    expect(html).toContain("unused 1");
    expect(html).toContain("exhausted 1");
    expect(html).toContain(">#4 · 12%<");
    expect(html).toContain("Window table");
    expect(html).not.toContain("show all");
  });
});
