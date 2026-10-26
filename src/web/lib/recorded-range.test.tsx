import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, refreshApiData, type HistoryCoverageResponse } from "./api";
import { recordedRange } from "./recorded-range";
import { setLanguage } from "./i18n";
import { chooseOption, flushUntil, installTestDom, invoke, type TestNode } from "./test-dom-harness";
import { Usage } from "../screens/Usage";
import { GlobalCapacity } from "../components/GlobalCapacity";

const row = { subscription: "a", usage: { first_day: "2025-03-01", last_day: "2026-09-10" },
  gauge: { first_at: "2025-02-01T23:00:00Z", last_at: "2026-10-15T20:00:00Z" } };
const coverage = () => ({ subscriptions: [row] }) as HistoryCoverageResponse;
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

test("All bounds include meter-only history, and global traffic includes unattributed account metadata", () => {
  expect(recordedRange([row], [], true)).toEqual({ since: "2025-02-01", until: "2026-10-15" });
  expect(recordedRange([row], [], false)).toEqual({ since: "2025-03-01", until: "2026-09-10" });
  expect(recordedRange([row], [{ first_event_ts: "2024-01-01T12:00:00Z", last_event_ts: "2026-09-12T12:00:00Z" }], false))
    .toEqual({ since: "2024-01-01", until: "2026-09-12" });
  expect(recordedRange([], [], true)).toBeNull();
});

test("Usage All waits for metadata, reads the whole stored span, refreshes its bounds and reports failures", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  let release!: (value: HistoryCoverageResponse) => void;
  let answer = coverage();
  const bounds = spyOn(api, "historyCoverage").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockImplementation(async () => answer);
  const accounts = spyOn(api, "accounts").mockResolvedValue({ count: 0, subscriptions: [] });
  const read = spyOn(api, "globalUsage").mockImplementation(async range => ({ ...range, timezone: "UTC", rows: [], sources: [],
    excluded_duplicates: 0, conflicting_events: 0, approximate_time_events: 0, actual_cost_available: false }));
  const splits = spyOn(api, "claudeAccountSplits").mockImplementation(async range => ({ ...range, windows: [] }) as never);
  const button = (label: string) => nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === label)!;
  try {
    await act(async () => root.render(<Usage />));
    await flushUntil(() => read.mock.calls.length === 1);
    expect(bounds).not.toHaveBeenCalled();
    await invoke(button("All"), "onClick");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => release(answer));
    await flushUntil(() => read.mock.calls.length === 2);
    expect(read.mock.calls.at(-1)![0]).toEqual({ since: "2025-03-01", until: "2026-09-10" });
    expect(button("All").attributes["aria-pressed"]).toBe("true");
    answer = { ...answer, subscriptions: [{ ...answer.subscriptions[0]!, usage: { ...answer.subscriptions[0]!.usage, first_day: "2024-03-01", last_day: "2026-09-20" } }] };
    await act(async () => refreshApiData());
    await flushUntil(() => read.mock.calls.some(([range]) => range.since === "2024-03-01"));
    expect(read.mock.calls.at(-1)![0]).toEqual({ since: "2024-03-01", until: "2026-09-20" });
    bounds.mockRejectedValue(new Error("coverage unavailable"));
    await act(async () => refreshApiData());
    await flushUntil(() => dom.host.textContent.includes("coverage unavailable"));
    expect(button("All").attributes["aria-pressed"]).toBe("true");
  } finally { await act(async () => root.unmount()); bounds.mockRestore(); accounts.mockRestore(); read.mockRestore(); splits.mockRestore(); dom.restore(); }
});

test("Global capacity All reads exact coverage bounds including old and recent meter observations", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  setLanguage("en");
  const bounds = spyOn(api, "historyCoverage").mockResolvedValue(coverage());
  const accounts = spyOn(api, "accounts").mockResolvedValue({ count: 0, subscriptions: [] });
  const read = spyOn(api, "capacityCycles").mockImplementation(async range => ({ ...range, accounts: [] }));
  try {
    await act(async () => root.render(<GlobalCapacity accounts={[]} cards={[]} />));
    await flushUntil(() => read.mock.calls.length === 1);
    const period = nodes(dom.host).find(node => node.attributes["aria-label"] === "History")!;
    await chooseOption(period, "0");
    await flushUntil(() => read.mock.calls.length === 2);
    expect(read.mock.calls.at(-1)![0]).toEqual({ since: "2025-02-01", until: "2026-10-15", window_minutes: 10080 });
  } finally { await act(async () => root.unmount()); bounds.mockRestore(); accounts.mockRestore(); read.mockRestore(); dom.restore(); }
});
