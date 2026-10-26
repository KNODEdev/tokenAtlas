import { describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexAccountingReport } from "../../server/codex-accounting";
import type { CodexComparisonWindow, WindowUsage } from "../../server/codex-window-comparison";
import { api } from "../lib/api";
import { chooseOption, dropdownOptions, dropdowns, dropdownValue, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import { capacityPeriodLabel } from "../lib/codex-capacity";
import { CodexSpeedStats } from "./CodexSpeedStats";
import type { DataSettingsTarget } from "../lib/data-settings";

type Coverage = CodexAccountingReport["normalization"]["standard_api_usd"];
type BreakdownRow = CodexAccountingReport["breakdown"][number];

function coverage(value: number): Coverage {
  return {
    value,
    priced_subtotal: value,
    status: "complete",
    priced_events: 1,
    unpriced_events: 0,
    priced_tokens: 1_000,
    unpriced_tokens: 0,
    reasons: {},
  };
}

function normalization(value = 1): CodexAccountingReport["normalization"] {
  return {
    standard_api_usd: coverage(value),
    normalized_usd: coverage(value),
    standard_credits: coverage(value),
    extra_credits: coverage(value),
  };
}

function usage(tokens = 1_000): WindowUsage {
  return {
    events: 1,
    tokens,
    input: tokens - 200,
    cached: 100,
    output: 300,
    fast_tokens: 500,
    unknown_tokens: 0,
    priced_tokens: tokens,
    unpriced_events: 0,
    api_standard: 20,
    credits_low: 30,
    credits_high: 40,
  };
}

function dimension(name: string): WindowUsage & { name: string } {
  return { name, ...usage() };
}

function windowRow(id: string, start: string, end: string, reset: string, source: string, model: string): CodexComparisonWindow {
  return {
    id,
    account: "codex1",
    plan: "plus",
    start,
    end,
    reset,
    start_percent: 10,
    end_percent: 40,
    observed_pp: 30,
    probes: 2,
    max_gap_hours: 1,
    usage: usage(),
    sources: [dimension(source)],
    models: [dimension(model)],
  };
}

function breakdownRow(index: number): BreakdownRow {
  return {
    day: new Date(Date.parse("2026-06-12") + index * 86_400_000).toISOString().slice(0, 10),
    model: index % 2 ? "gpt-5.6-sol" : "gpt-5.6-luna",
    speed: index % 2 ? "standard" : "fast",
    account: "codex1",
    home: `PC-${index}`,
    events: 1,
    tokens: 1_000,
    amounts: { chatgpt_credits: coverage(30), api_equivalent_usd: coverage(20) },
    normalization: normalization(1),
  };
}

function report(breakdownCount: number): CodexAccountingReport {
  const before = windowRow(
    "before",
    "2026-08-01T00:00:00Z",
    "2026-08-03T00:00:00Z",
    "2026-08-08T00:00:00Z",
    "EXAMPLE-MAIN",
    "gpt-5.6-luna",
  );
  const after = windowRow(
    "after",
    "2026-09-01T00:00:00Z",
    "2026-09-03T00:00:00Z",
    "2026-09-08T00:00:00Z",
    "EXAMPLE-LAPTOP-A",
    "gpt-5.6-sol",
  );
  const breakdown = Array.from({ length: breakdownCount }, (_, index) => breakdownRow(index));
  return {
    schema_version: 1,
    scope: { since: "2026-06-12", until: "2026-09-09", account: "codex1" },
    quantity_basis: "indexed_token_events",
    tier_evidence: "configured",
    quota_verified: false,
    source: "raw-events",
    account_attribution: "account-periods",
    deduplication: "existing_source_archive_policy",
    rule_source: "shipped",
    events: breakdownCount,
    tokens: breakdownCount * 1_000,
    known_speed_events: breakdownCount,
    known_speed_tokens: breakdownCount * 1_000,
    unknown_speed_events: 0,
    unknown_speed_tokens: 0,
    excluded_mirror_events: 0,
    unattributed_events: 0,
    source_home_count: breakdownCount,
    amounts: { chatgpt_credits: coverage(30), api_equivalent_usd: coverage(20) },
    normalization: normalization(),
    breakdown,
    windows: [before, after],
    calibration: null,
    applied_rules: [],
    subjects: [],
    limitations: [],
  };
}

function allNodes(root: TestNode): TestNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

function findButton(root: TestNode, prefix: string): TestNode | null {
  return allNodes(root).find((node) => node.tagName === "BUTTON" && node.textContent.startsWith(prefix)) ?? null;
}

// The dropdown listing every required option; each candidate's list is opened to read it and closed again.
async function findSelect(root: TestNode, requiredOptions: string[]): Promise<TestNode | null> {
  for (const trigger of dropdowns(root)) {
    const labels = (await dropdownOptions(trigger)).map((option) => option.label);
    await invoke(trigger, "onClick");
    if (requiredOptions.every((option) => labels.includes(option))) return trigger;
  }
  return null;
}

async function waitForSelect(root: TestNode, requiredOptions: string[]): Promise<TestNode> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = await findSelect(root, requiredOptions);
    if (found) return found;
    await act(async () => { await Promise.resolve(); });
  }
  throw new Error(`dropdown with ${requiredOptions.join(", ")} not found`);
}

function findInput(root: TestNode, ariaLabel: string): TestNode | null {
  return allNodes(root).find((node) => node.tagName === "INPUT" && node.getAttribute("aria-label") === ariaLabel) ?? null;
}

function findTable(root: TestNode, requiredText: string[]): TestNode | null {
  return allNodes(root).find((node) => node.tagName === "TABLE"
    && requiredText.every((text) => node.textContent.includes(text))) ?? null;
}

function bodyRows(table: TestNode): TestNode[] {
  const body = table.children.find((node) => node.tagName === "TBODY");
  return body?.children.filter((node) => node.tagName === "TR") ?? [];
}

function hasAncestor(node: TestNode, tagName: string): boolean {
  for (let current = node.parentNode; current; current = current.parentNode) {
    if (current.tagName === tagName) return true;
  }
  return false;
}

function reactProps(node: TestNode): Record<string, (...args: never[]) => unknown> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props missing on ${node.tagName}`);
  return (node as unknown as Record<string, Record<string, (...args: never[]) => unknown>>)[key]!;
}

function inputValue(node: TestNode): unknown {
  return (reactProps(node) as unknown as { value: unknown }).value;
}

async function invokeChange(node: TestNode, value: string): Promise<void> {
  const handler = reactProps(node).onChange;
  if (!handler) throw new Error(`onChange missing on ${node.tagName}`);
  await act(async () => {
    handler({ target: { value } } as never);
  });
}

async function withStats<T>(breakdownCount: number, callback: (host: TestNode, accountingCalls: () => number) => Promise<T>, section: "capacity" | "models" = "capacity"): Promise<T> {
  const { host, restore } = installTestDom();
  setLanguage("en");
  const fixture = report(breakdownCount);
  const markerApi = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "test", automatic: [], markers: [] });
  const accounting = spyOn(api, "codexAccounting").mockImplementation(async (options) => ({ ...fixture, scope: options }));
  // The Models view reads its launch contexts and per-model cache counters separately.
  const contexts = spyOn(api, "breakdown").mockResolvedValue({ rows: [] });
  const cache = spyOn(api, "modelCacheHistory").mockImplementation(async range => ({ ...range, grain: "day", from: `${range.since}T00:00:00.000Z`, until: `${range.until}T00:00:00.000Z`, hours: [] }));
  const root = createRoot(host as unknown as Element);
  try {
    await act(async () => {
      root.render(<CodexSpeedStats account="codex1" section={section} />);
    });
    await flushUntil(() => host.textContent.includes("Daily details") || host.textContent.includes("Capacity at 100% in successive cycles") || host.textContent.includes("No cycles meet the minimum observed usage filter"));
    return await callback(host, () => accounting.mock.calls.length);
  } finally {
    await act(async () => root.unmount());
    accounting.mockRestore();
    contexts.mockRestore();
    cache.mockRestore();
    markerApi.mockRestore();
    restore();
    setLanguage("en");
  }
}

describe("CodexSpeedStats views", () => {
  it("switches Codex to its 5h API counter and keeps that choice across chart views", async () => {
    const { host, restore } = installTestDom(); setLanguage("en");
    const fixture = report(2);
    const accounting = spyOn(api, "codexAccounting").mockImplementation(async options => ({ ...fixture, scope: options,
      provider: { id: "codex", label: "Codex", credits: true, speed: true, counter: options.window_minutes === 300 ? "five_hour" : "weekly", counter_reason: null,
        counters: [{ id: "weekly", label: "Weekly · 10080m" }, { id: "five_hour", label: "5h · 300m" }] } }));
    const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "test", automatic: [], markers: [] });
    const root = createRoot(host as unknown as Element);
    try {
      await act(async () => root.render(<CodexSpeedStats account="codex1" />));
      await chooseOption(await waitForSelect(host, ["Weekly · 10080m", "5h · 300m"]), "five_hour");
      await flushUntil(() => accounting.mock.calls.some(([options]) => options.window_minutes === 300));
      expect(accounting.mock.calls.at(-1)![0].window_minutes).toBe(300);
      await chooseOption((await findSelect(host, ["7 days", "30 days"]))!, "7");
      await flushUntil(() => accounting.mock.calls.length === 3);
      expect(accounting.mock.calls.at(-1)![0].window_minutes).toBe(300);
      expect(host.textContent).toContain("5h and weekly limits have separate percentages");
    } finally { await act(async () => root.unmount()); accounting.mockRestore(); markers.mockRestore(); restore(); }
  });

  it("restores the analysis range and forwards it with contextual settings actions", async () => {
    const { host, restore } = installTestDom();
    setLanguage("en");
    const range = { since: "2026-08-16", until: "2026-08-23" };
    const targets: DataSettingsTarget[] = [];
    const fixture = report(2);
    const accounting = spyOn(api, "codexAccounting").mockImplementation(async options => ({ ...fixture, scope: options }));
    const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "test", automatic: [], markers: [] });
    const root = createRoot(host as unknown as Element);
    try {
      await act(async () => root.render(<CodexSpeedStats account="codex1" initialRange={range} openDataSettings={target => targets.push(target)} />));
      await invoke(findButton(host, "Edit dated prices")!, "onClick");
      expect(accounting.mock.calls[0]?.[0]).toMatchObject({ ...range, account: "codex1" });
      expect(targets[0]).toEqual({ ...range, account: "codex1", area: "rates", returnRange: range });
      await invoke(findButton(host, "Complete data / events")!, "onClick");
      expect(targets[1]).toEqual({ ...range, account: "codex1", area: "data", returnRange: range });
    } finally { await act(async () => root.unmount()); accounting.mockRestore(); markers.mockRestore(); restore(); }
  });
  it("shows four capacity views and exposes the measurements controls directly", async () => {
    await withStats(2, async (host) => {
      expect(allNodes(host).filter((node) => node.getAttribute("role") === "tab").map((node) => node.textContent)).toEqual([
        "Capacity",
        "By model",
        "Measurements",
        "Methodology",
      ]);
      expect(allNodes(host).filter((node) => node.getAttribute("role") === "tablist")).toHaveLength(1);

      await invoke(findButton(host, "Measurements")!, "onClick");

      const table = findTable(host, ["Measurement from → to (UTC)", "Details"]);
      const chooseColumns = findButton(host, "Choose columns");
      expect(table).not.toBeNull();
      expect(chooseColumns).not.toBeNull();
      expect(findButton(host, "Download CSV")).not.toBeNull();
      expect(hasAncestor(chooseColumns!, "DETAILS")).toBe(false);

      const preset = await findSelect(host, ["Capacity", "Tokens and mode", "Sources and quality", "All"]);
      expect(preset).not.toBeNull();
      expect(allNodes(host).some((node) => node.tagName === "BUTTON" && node.textContent === "Tokens and mode")).toBe(false);
      expect(allNodes(host).some((node) => node.tagName === "BUTTON" && node.textContent === "Sources and quality")).toBe(false);
      expect(allNodes(host).some((node) => node.tagName === "BUTTON" && node.textContent === "All")).toBe(false);
    });
  });

  it("keeps unit switches local and requests the exact day span of every history preset", async () => {
    await withStats(2, async (host, calls) => {
      expect(host.textContent).toContain("Capacity at 100% in successive cycles · API $");
      await invoke(findButton(host, "Credits")!, "onClick");
      expect(host.textContent).toContain("Capacity at 100% in successive cycles · Credits");
      expect(calls()).toBe(1);
      const period = allNodes(host).find(node => node.getAttribute("aria-label") === "Analysis period")!;
      for (const days of [7, 14, 30, 60, 90, 180, 360]) {
        const before = calls();
        await chooseOption(period, String(days));
        await flushUntil(() => calls() === before + 1);
        const args = (api.codexAccounting as unknown as { mock: { calls: [{ since: string; until: string }][] } }).mock.calls.at(-1)![0];
        expect((Date.parse(args.until) - Date.parse(args.since)) / 86400000 + 1).toBe(days);
      }
    });
  });

  it("All fits the subscription's stored history instead of a rolling year", async () => {
    const coverage = spyOn(api, "historyCoverage").mockResolvedValue({ generated_at: "2026-10-16T00:00:00Z", subscriptions: [{
      subscription: "codex1", usage: { first_day: "2025-03-01", last_day: "2026-09-10" },
      gauge: { first_at: "2025-02-01T00:00:00Z", last_at: "2026-10-15T20:00:00Z" },
    }] } as Awaited<ReturnType<typeof api.historyCoverage>>);
    try {
      await withStats(2, async (host, calls) => {
        const period = allNodes(host).find(node => node.getAttribute("aria-label") === "Analysis period")!;
        await chooseOption(period, "-1");
        await flushUntil(() => calls() === 2);
        const args = (api.codexAccounting as unknown as { mock: { calls: [{ since: string; until: string }][] } }).mock.calls.at(-1)![0];
        expect(args).toMatchObject({ since: "2025-02-01", until: "2026-10-15" });
        expect(coverage.mock.calls[0]![0]).toBe("codex1");
      });
    } finally { coverage.mockRestore(); }
  });

  it("expands named row details and retains reference and columns across view switches", async () => {
    await withStats(2, async (host, accountingCalls) => {
      await invoke(findButton(host, "Measurements")!, "onClick");
      const preset = (await findSelect(host, ["Capacity", "Tokens and mode", "Sources and quality", "All"]))!;
      const options = report(2).windows!.map(w => capacityPeriodLabel(w, "en-US") + " · plus · 40%");
      const reference = (await findSelect(host, options))!;
      await chooseOption(preset, "1");
      await chooseOption(reference, "after");

      await invoke(findButton(host, "Details")!, "onClick");
      expect(host.textContent).toContain("Computers and sources");
      expect(host.textContent).toContain("EXAMPLE-MAIN");
      expect(host.textContent).toContain("Models");
      expect(host.textContent).toContain("gpt-5.6-luna");

      await invoke(findButton(host, "Methodology")!, "onClick");
      await invoke(findButton(host, "Capacity")!, "onClick");

      const referenceSelect = (await findSelect(host, options))!;
      expect(await dropdownValue(referenceSelect)).toBe("after");
      const cycleDetails = allNodes(host).find(node => node.tagName === "BUTTON" && node.getAttribute("aria-label")?.startsWith("Cycle details:"));
      expect(cycleDetails).toBeDefined();
      await invoke(cycleDetails!, "onClick");
      expect(host.textContent).toContain("Calculation interval");

      await invoke(findButton(host, "Measurements")!, "onClick");

      expect(accountingCalls()).toBe(2); // The cycle drawer requests its detailed timeline.
      expect(await findSelect(host, ["Capacity", "Tokens and mode", "Sources and quality", "All"])).not.toBeNull();
      expect(findTable(host, ["Input + output tokens", "Million tokens / pp"])).not.toBeNull();
    });
  });

  it("keeps inactive usage rows out of the DOM and paginates active usage at 50", async () => {
    await withStats(120, async (host) => {
      expect(allNodes(host).filter(node => node.getAttribute("role") === "tab").map(node => node.textContent)).toEqual(["Traffic history", "Models & sources"]);
      expect(host.textContent).not.toContain("How much fits in 1%");
      let traffic = findTable(host, ["Day", "Model / mode", "Source", "Tokens"]);
      expect(traffic).not.toBeNull();
      expect(bodyRows(traffic!)).toHaveLength(50);
      expect(host.textContent).toContain("Page 1 / 3");
      expect(findButton(host, "Next")).not.toBeNull();

      await invoke(findButton(host, "Next")!, "onClick");
      traffic = findTable(host, ["Day", "Model / mode", "Source", "Tokens"]);
      expect(bodyRows(traffic!)).toHaveLength(50);
      expect(host.textContent).toContain("Page 2 / 3");

      await invoke(findButton(host, "Traffic history")!, "onClick");
      expect(findTable(host, ["Day", "Model / mode", "Source", "Tokens"])).toBeNull();
      expect(host.textContent).not.toContain("PC-119");
    }, "models");
  });

  it("persists the numeric minimum and filters cycle views without changing traffic totals", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    try {
      await withStats(2, async (host) => {
        const input = findInput(host, "Minimum observed usage percentage");
        expect(input).not.toBeNull();
        expect(inputValue(input!)).toBe("10");
        await invokeChange(input!, "31");
        expect(inputValue(input!)).toBe("31");
        expect(host.textContent).toContain("2 cycles · 2 below minimum (< 31 pp)");
        expect(host.textContent).toContain("tentative estimate");
        expect(host.textContent).not.toContain("No cycles meet the minimum observed usage filter");
        expect(values.get("tokenatlas.codex-capacity-min-observed-percent.v1")).toBe("31");
      });

      await withStats(2, async (host) => {
        const input = findInput(host, "Minimum observed usage percentage");
        expect(input).not.toBeNull();
        expect(inputValue(input!)).toBe("31");
        expect(host.textContent).toContain("2 cycles · 2 below minimum (< 31 pp)");
      });
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

it("opens Business history without requiring a percentage meter", async () => {
  const {host,restore}=installTestDom(); setLanguage("en");
  const fixture={...report(2),windows:[]};
  const marker=spyOn(api,"codexTimelineMarkers").mockResolvedValue({revision:"test",automatic:[],markers:[]});
  const accounting=spyOn(api,"codexAccounting").mockImplementation(async options=>({...fixture,scope:options}));
  const contexts=spyOn(api,"breakdown").mockResolvedValue({rows:[]});
  const cache=spyOn(api,"modelCacheHistory").mockImplementation(async range=>({...range,grain:"day",from:`${range.since}T00:00:00.000Z`,until:`${range.until}T00:00:00.000Z`,hours:[]}));
  const root=createRoot(host as unknown as Element);
  try {
    await act(async()=>root.render(<CodexSpeedStats account="personal::business" section="models" />));
    await flushUntil(()=>host.textContent.includes("No weekly subscription allowance."));
    expect(host.textContent).toContain("Business credits · 2k tokens");
    expect(findTable(host,["Day","Model / mode","Source","Tokens"])).not.toBeNull();
    const request=accounting.mock.calls[0]![0];
    expect((Date.parse(request.until)-Date.parse(request.since))/86400000+1).toBe(360);
  } finally {
    await act(async()=>root.unmount()); accounting.mockRestore();contexts.mockRestore();cache.mockRestore();marker.mockRestore();restore();
  }
});
