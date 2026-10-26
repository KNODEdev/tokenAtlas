import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexWindowCacheTimeline } from "../../shared/codex-window-detail";
import { setLanguage } from "../lib/i18n";
import { ModelCacheHistory } from "./ModelCacheHistory";
import { cacheShareAxis, modelCachePeriods } from "../lib/model-cache-history";
import { api } from "../lib/api";
import { chooseOption, dropdownOptions, flushUntil, installTestDom, type TestNode } from "../lib/test-dom-harness";

const timeline: CodexWindowCacheTimeline = { from: "2026-10-15T08:19:00Z", until: "2026-10-18T08:19:00Z", hours: [
  { model: "a", hour: "2026-10-15T08:00:00Z", input: 100, cached: 100, calls: 1 },
  { model: "a", hour: "2026-10-15T09:00:00Z", input: 900, cached: 0, calls: 9 },
  { model: "b", hour: "2026-10-15T09:00:00Z", input: 1000, cached: 1000, calls: 3 },
  { model: "a", hour: "2026-10-16T13:00:00Z", input: 0, cached: 0, calls: 1 },
  { model: "a", hour: "2026-10-18T08:00:00Z", input: 1000, cached: 980, calls: 2 },
] };

test("daily cache share is a ratio of sums for the selected model, retaining partial boundaries and empty periods", () => {
  const periods = modelCachePeriods(timeline, "a");
  expect(periods.map(period => [period.input, period.cached, period.percent])).toEqual([
    [1000, 100, 10], [0, 0, null], [0, 0, null], [1000, 980, 98],
  ]);
  expect(periods[0]!.from).toBe(Date.parse(timeline.from));
  expect(periods.at(-1)!.until).toBe(Date.parse(timeline.until));
  expect(periods.reduce((sum, period) => sum + period.cached, 0)).toBe(1080);
});

test("short cycles retain UTC hour gaps and distinguish no input from a real 0%", () => {
  const short = { ...timeline, until: "2026-10-15T11:19:00Z", hours: [...timeline.hours,
    { model: "a", hour: "2026-10-15T11:00:00Z", input: 0, cached: 0, calls: 1 }] };
  expect(modelCachePeriods(short, "a").map(period => period.percent)).toEqual([100, 0, null, null]);
});

test("the chart breaks the path at missing input, keeps a wide spread on the full axis and exposes exact counts", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<ModelCacheHistory timeline={timeline} model="a" />);
  expect(html).toContain("daily");
  expect(html).toContain("100%");
  expect(html).toContain("10.0% · cache read 100 / input 1,000");
  expect(html).toContain("2026-10-15 08:19:00 UTC");
  const path = /<path d="([^"]*)"/.exec(html)![1]!;
  expect(path.match(/M/g)).toHaveLength(2);
  expect(path).not.toContain("L");
  expect(html).not.toMatch(/NaN|Infinity/);
});

test("missing history in an older stored answer is unavailable rather than a zero chart", () => {
  setLanguage("en");
  expect(renderToStaticMarkup(<ModelCacheHistory model="a" />)).toContain("Cache history unavailable");
  expect(renderToStaticMarkup(<ModelCacheHistory timeline={timeline} model="unseen" />)).not.toContain("<svg");
});

test("the selector opens on 30 days, reuses every shared preset, fetches the chosen account/model, and restores Cycle without a fetch", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const read = spyOn(api, "modelCacheHistory").mockImplementation(async range => ({ account: range.account, model: range.model,
    grain: "day", from: `${range.since ?? "2024-01-01"}T00:00:00.000Z`, until: new Date(Date.parse(range.until) + 86_400_000).toISOString(), hours: [
      { model: range.model, hour: `${range.since ?? "2024-01-01"}T00:00:00.000Z`, input: 100, cached: 100, calls: 1 },
      { model: range.model, hour: `${range.until}T00:00:00.000Z`, input: 900, cached: 0, calls: 2 },
    ] }));
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  const selector = () => nodes(dom.host).find(node => node.attributes["aria-label"] === "Cache history range")!;
  const share = () => nodes(dom.host).find(node => node.attributes["data-fact"] === "cache-range-share")!.textContent;
  try {
    await act(async () => root.render(<ModelCacheHistory timeline={timeline} model="a" account="selected" />));
    await flushUntil(() => read.mock.calls.length === 1);
    const initial = read.mock.calls[0]![0];
    expect((Date.parse(initial.until) - Date.parse(initial.since!)) / 86_400_000 + 1).toBe(30);
    expect((await dropdownOptions(selector())).map(option => option.label)).toEqual([
      "Cycle", "7 days", "14 days", "30 days", "60 days", "90 days", "180 days", "360 days (year)", "All",
    ]);
    await chooseOption(selector(), "90");
    await flushUntil(() => read.mock.calls.length === 2 && share().includes("10.0%"));
    const request = read.mock.calls.at(-1)![0];
    expect(request.account).toBe("selected"); expect(request.model).toBe("a");
    expect((Date.parse(request.until) - Date.parse(request.since!)) / 86_400_000 + 1).toBe(90);
    await chooseOption(selector(), "360");
    await flushUntil(() => read.mock.calls.length === 3);
    const year = read.mock.calls.at(-1)![0];
    expect((Date.parse(year.until) - Date.parse(year.since!)) / 86_400_000 + 1).toBe(360);
    await chooseOption(selector(), "all");
    await flushUntil(() => read.mock.calls.length === 4);
    expect(read.mock.calls.at(-1)![0].since).toBeUndefined();
    await chooseOption(selector(), "cycle");
    expect(read).toHaveBeenCalledTimes(4);
    expect(dom.host.textContent).toContain("2026-10-15");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("a late range response cannot overwrite a newly selected range or another account", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const pending: Array<{ range: Parameters<typeof api.modelCacheHistory>[0]; signal?: AbortSignal;
    finish: (data: Awaited<ReturnType<typeof api.modelCacheHistory>>) => void }> = [];
  const read = spyOn(api, "modelCacheHistory").mockImplementation((range, signal) => new Promise(finish => { pending.push({ range, signal, finish }); }));
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  const selector = () => nodes(dom.host).find(node => node.attributes["aria-label"] === "Cache history range")!;
  try {
    await act(async () => root.render(<ModelCacheHistory timeline={timeline} model="a" account="old" />));
    await flushUntil(() => pending.length === 1);
    await chooseOption(selector(), "90");
    await flushUntil(() => pending.length === 2);
    expect(pending[0]!.signal!.aborted).toBe(true);
    await act(async () => root.render(<ModelCacheHistory timeline={timeline} model="b" account="new" />));
    await flushUntil(() => pending.length === 3);
    expect(pending[1]!.signal!.aborted).toBe(true);
    await act(async () => pending[0]!.finish({ ...timeline, account: "old", model: "a" }));
    expect(dom.host.textContent).not.toContain("10.0%");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("weekly and monthly history retain ratio-of-sums totals and calendar gaps", () => {
  const weekly = modelCachePeriods({ ...timeline, from: "2026-09-01T00:00:00Z", until: "2026-12-01T00:00:00Z", grain: "day" }, "a");
  expect(weekly.length).toBeLessThan(15);
  expect(weekly.reduce((sum, point) => sum + point.cached, 0)).toBe(1080);
  const monthly = modelCachePeriods({ ...timeline, from: "2026-01-01T00:00:00Z", until: "2027-01-01T00:00:00Z", grain: "day" }, "a");
  expect(monthly.length).toBe(12);
  expect(monthly[9]!.percent).toBe(54);
  expect(monthly[0]!.percent).toBeNull();
});


test("long cache history names days and years even when its data is grouped by month", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<ModelCacheHistory timeline={{ ...timeline, from: "2025-01-01T00:00:00Z", until: "2027-01-01T00:00:00Z", grain: "day" }} model="a" />);
  expect(html).toContain("monthly");
  expect(html).toContain("01/01/25</text>");
  expect(html).toContain("12/31/26</text>");
  expect(html).toContain("2026-12-31 23:59:59.999 UTC");
});

test("the share axis fits a narrow spread near 100% and keeps at least one percentage point", () => {
  expect(cacheShareAxis([96.8, 97.4, 98.2])).toEqual({ min: 96.5, max: 98.5, step: 0.5, ticks: [96.5, 97, 97.5, 98, 98.5] });
  const flat = cacheShareAxis([99.6, 99.6]);
  expect(flat.max).toBe(100);
  expect(flat.max - flat.min).toBeGreaterThanOrEqual(1);
  expect(cacheShareAxis([0, 0]).min).toBe(0);
  expect(cacheShareAxis([10, 98])).toMatchObject({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
  expect(cacheShareAxis([])).toMatchObject({ min: 0, max: 100 });
});

test("the drawn axis labels the fitted range rather than 0-100%", () => {
  setLanguage("en");
  const narrow = { ...timeline, hours: [
    { model: "a", hour: "2026-10-15T09:00:00Z", input: 1000, cached: 968, calls: 1 },
    { model: "a", hour: "2026-10-17T09:00:00Z", input: 1000, cached: 982, calls: 1 },
  ] };
  const html = renderToStaticMarkup(<ModelCacheHistory timeline={narrow} model="a" />);
  expect(html).toContain(">96.5%</text>");
  expect(html).toContain(">98.5%</text>");
  expect(html).not.toContain(">0%</text>");
  expect(html).not.toMatch(/NaN|Infinity/);
});
