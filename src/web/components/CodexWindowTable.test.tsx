import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLanguage } from "../lib/i18n";
import { createRoot } from "react-dom/client";
import type { CodexComparisonWindow, WindowUsage } from "../../shared/codex-accounting";
import { CodexWindowTable, MeasurementDetails } from "./CodexWindowTable";
import { findByAttribute, findByText, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { api, ApiError } from "../lib/api";

const usage = (overrides: Partial<WindowUsage> = {}): WindowUsage => ({
  events: 1, tokens: 1_000, input: 800, cached: 100, output: 200, fast_tokens: 0,
  unknown_tokens: 0, priced_tokens: 1_000, unpriced_events: 0, api_standard: 20,
  credits_low: 30, credits_high: 40, ...overrides,
});

const row: CodexComparisonWindow = {
  id: "cycle", account: "codex1", plan: "plus", start: "2026-09-01T00:00:00Z", end: "2026-09-03T00:00:00Z",
  reset: "2026-09-08T00:00:00Z", start_percent: 0, end_percent: 70, observed_pp: 70, probes: 2, max_gap_hours: 1,
  usage: usage(), sources: [
    { name: "PC-1", ...usage({ cache_write_5m: 0, cache_write_1h: 120, cache_write_unknown: 3 }) },
  ], models: [{ name: "model-1", ...usage({ cache_write_5m: 0, cache_write_1h: 120, cache_write_unknown: 3 }) }],
};

test("non-credit table removes credit columns and shows cache write details", async () => {
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  try {
    await act(async () => {
      root.render(<CodexWindowTable windows={[row]} view="measurements" creditsAvailable={false} />);
    });
    expect(dom.host.textContent).not.toContain("Credits");
    expect(findByAttribute(dom.host, "aria-label", "Subscription capacity comparison")).not.toBeNull();
    const details = findByAttribute(dom.host, "aria-label", "Details: 2026-09-01 00:00 → 2026-09-03 00:00");
    expect(details).not.toBeNull();
    await invoke(details!, "onClick", { currentTarget: details, stopPropagation() {} });
    expect(dom.host.textContent).toContain("Cache write 5m");
    expect(dom.host.textContent).toContain("Cache write 1h");
    expect(dom.host.textContent).toContain("Cache write unknown");
    expect(dom.host.textContent).not.toContain("Credits: unknown Standard / Fast");
    expect(dom.host.textContent).toContain("0");
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});

test("a manual reading can be edited and removed in place, with a confirmation and a conflict message", async () => {
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const manualRow: CodexComparisonWindow = { ...row, id: "manual-cycle", manual_measurement: { id: "m1", approximate_time: false, note: "read from the app" } };
  const read = spyOn(api, "manualCapacity").mockImplementation(async () => ({ revision: "r1", measurements: [{
    id: "m1", account: "claude", counter: JSON.stringify(["weekly_all", "weekly", 10080]), start: "2026-09-01T00:00:00Z", end: "2026-09-03T00:00:00Z",
    start_percent: 0, end_percent: 70, approximate_time: false, note: "read from the app", updated_at: "2026-09-03T00:00:00Z" }] }));
  let conflict = true;
  const save = spyOn(api, "saveManualCapacity").mockImplementation(async () => {
    if (conflict) { conflict = false; throw new ApiError("Pomiary zmieniły się.", 409); }
    return { revision: "r2", measurements: [] };
  });
  const saved: unknown[][] = [];
  const manual = { provider: "claude", account: "claude", windows: [manualRow], onSaved: (...args: unknown[]) => { saved.push(args); } };
  const byLabel = (label: string) => findByAttribute(dom.host, "aria-label", label)!;
  try {
    await act(async () => { root.render(<CodexWindowTable windows={[manualRow]} view="measurements" creditsAvailable={false} manual={manual} />); });
    expect(dom.host.textContent).toContain("manual");
    await invoke(byLabel("Edit manual reading: 2026-09-01 00:00 → 2026-09-03 00:00"), "onClick");
    await flushUntil(() => dom.host.textContent.includes("Edit manual reading") && findByAttribute(dom.host, "aria-label", "End percentage")?.value === "70");
    await invoke(byLabel("Remove manual reading: 2026-09-01 00:00 → 2026-09-03 00:00"), "onClick");
    expect(save).not.toHaveBeenCalled();
    await invoke(findByText(dom.host, "BUTTON", "Yes, remove")!, "onClick");
    await flushUntil(() => dom.host.textContent.includes("stored readings changed"));
    expect(saved).toHaveLength(0);
    await invoke(findByText(dom.host, "BUTTON", "Yes, remove")!, "onClick");
    await flushUntil(() => saved.length === 1);
    expect(save.mock.calls.at(-1)![2]).toEqual({ revision: "r1", remove: "m1" });
  } finally {
    await act(async () => { root.unmount(); });
    read.mockRestore(); save.mockRestore(); dom.restore();
  }
});


test("measurement drawer body shows evidence and usage with no nested disclosures", () => {
  setLanguage("en");
  const measured: CodexComparisonWindow = { ...row, evidence: {
    archive_completeness: "unconfirmed", mode_relevant: true,
    meter_gaps: [{ from: row.start, to: row.end, minutes: 2880 }],
    sources: [{ name: "PC-1", first: row.start, last: row.end, events: 1, tokens: 1000, paired_events: 1, paired_tokens: 1000 }],
    declared_sources: [], excluded_events: { counter: 0, plan: 0, reset: 0 },
    imports: { stored_runs: 1, inspected_runs: 1, unreadable_runs: 0, truncated: false, related_count: 1,
      related: [{ id: "import-1", started: row.start, status: "complete", has_error: false, warnings: 0, relation: "changed_range" }] },
  } };
  const html = renderToStaticMarkup(<CodexWindowTable windows={[measured]} view="measurements" />);
  expect(html).not.toContain("Stored provider import attempts");
  expect(html).not.toContain("measurements-panel-row");
  expect(html).toContain('aria-haspopup="dialog"');
  const body = renderToStaticMarkup(<MeasurementDetails row={measured} creditsAvailable={false} />);
  expect(body).toContain("Stored provider import attempts");
  expect(body).toContain("Gaps between meter readings over 5 minutes");
  expect(body).toContain("changed data dates");
  expect(body).toContain("2,880");
  expect(body).toContain("Computers and sources");
  expect(body).toContain("PC-1");
  expect(body).toContain("model-1");
  expect(body).toContain("Cache write 1h");
  expect(body).not.toContain("<details");
  expect(body).not.toContain("<summary");
});

test("clicking a measurement row opens its drawer and closing restores the row opener's focus", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  try {
    await act(async () => root.render(<CodexWindowTable windows={[row]} view="measurements" />));
    const opener = findByAttribute(dom.host, "aria-label", "Measurement details: 2026-09-01 00:00 → 2026-09-03 00:00")!;
    const focus = spyOn(opener, "focus");
    const tableRow = nodes(dom.host).find(node => node.tagName === "TR" && node.className === "ui-open-row")!;
    await invoke(tableRow, "onClick", { currentTarget: { querySelector: () => opener } });
    expect(nodes(dom.host).find(node => node.tagName === "DIALOG")?.hasAttribute("open")).toBe(true);
    expect(tableRow.className).toBe("ui-open-row is-selected");
    expect(nodes(dom.host).some(node => node.className === "measurements-panel-row")).toBe(false);
    expect(dom.host.textContent).toContain("Computers and sources");
    expect(dom.host.textContent).toContain("model-1");
    await invoke(findByAttribute(dom.host, "aria-label", "Close measurement details")!, "onClick");
    expect(nodes(dom.host).some(node => node.tagName === "DIALOG")).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(tableRow.className).toBe("ui-open-row");
    focus.mockRestore();
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
