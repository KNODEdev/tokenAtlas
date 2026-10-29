import { expect, setSystemTime, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, bustApiMemo, type ApiAccount } from "../lib/api";
import { emptyModel } from "../lib/cycle";
import { setLanguage } from "../lib/i18n";
import { ALL_ACCOUNT, type RosterCard } from "../lib/roster";
import { HIDDEN_MODELS_KEY, SPEED_SELECTION_KEY, type ModelSpeedPoint, type ModelSpeedResponse } from "../lib/model-speed";
import type { ScreenProps } from "../lib/screens";
import { flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { Speed } from "./Speed";

const point = (at: string, calls: number, out: number, ms: number): ModelSpeedPoint => ({ at, calls, timed_calls: calls, timed_out: out, timed_ms: ms,
  speed: out * 1000 / ms, long_calls: calls, long_out: out, long_ms: ms, long_speed: out * 1000 / ms, coverage: 1 });
const model = (name: string, points: ModelSpeedPoint[]) => ({ model: name, points, total: points.reduce((sum, p) => ({ ...sum,
  calls: sum.calls + p.calls, timed_calls: sum.timed_calls + p.timed_calls, timed_out: sum.timed_out + p.timed_out, timed_ms: sum.timed_ms + p.timed_ms,
  long_calls: sum.long_calls + p.long_calls, long_out: sum.long_out + p.long_out, long_ms: sum.long_ms + p.long_ms }), point("total", 0, 0, 1)) });
const RESPONSE: ModelSpeedResponse = { account: "codex1", provider: "codex", grain: "day", since: null, until: null, long_out_min: 256, models: [
  model("gpt-5.6-sol", [point("2026-09-28", 60, 24_000, 600_000), point("2026-10-05", 60, 24_000, 600_000)]),
  model("gpt-5.3-codex-spark", [point("2026-09-28", 60, 180_000, 600_000), point("2026-10-05", 60, 180_000, 600_000)]),
  // Claude Code's placeholder messages: never listed as a model.
  model("<synthetic>", [point("2026-10-05", 350, 0, 5_000)]),
] };
const account = (id: string, vendor: string): ApiAccount => ({ id, vendor, plan: "pro", login: id, machine: null, note: null, homes: [], ratelimit_rows: 0,
  event_rows: 0, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true });
const props = (id: string, vendor: string): ScreenProps => ({ model: emptyModel(id, 10080), account: id, accounts: [account(id, vendor)], card: null,
  capabilities: null, project: "", projects: [], unit: "percent", chosen: null, compare: [], windowRailInShell: false, sync: null,
  setUnit() {}, setProject() {}, selectAccount() {}, selectCycle() {}, openDrawer() {}, goto() {}, setCompare() {}, triggerSync() {} });
const card = (id: string, group: string, active = true) => ({ id, group, active, vendorAccount: `${id}@example.test` }) as RosterCard;
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

test("the same model has independently visible speed and first-token lines for each execution variant", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const variants = [["standard", "high", 1000], ["fast", "high", 2000], ["fast", "ultra", 9000], ["fast", null, 3000]] as const;
  const models = variants.map(([speed, effort, ms]) => {
    const p = { ...point("2026-10-25", 60, 60000, ms * 60), first_token: { turns: 60, histogram: [[ms, 60]] as Array<[number, number]> } };
    return { model: "gpt-6.1-sol", speed, effort, total: p, points: [p] };
  });
  const read = spyOn(api, "modelSpeed").mockResolvedValue({ ...RESPONSE, models });
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    for (const suffix of ["standard · high", "fast · high", "fast · ultra", "fast · unknown effort"])
      expect(dom.host.textContent).toContain(`gpt-6.1-sol · ${suffix}`);
    await invoke(toggles(dom.host, "gpt-6.1-sol · fast · ultra")[0]!, "onClick");
    expect(toggles(dom.host, "gpt-6.1-sol · fast · ultra").every(n => n.attributes["aria-pressed"] === "false")).toBe(true);
    expect(toggles(dom.host, "gpt-6.1-sol · fast · high").every(n => n.attributes["aria-pressed"] === "true")).toBe(true);
    await invoke(nodes(dom.host).find(n => n.tagName === "BUTTON" && n.textContent === "First token · median")!, "onClick");
    expect(dom.host.textContent).toContain("9.0 s");
    expect(nodes(dom.host).some(n => n.tagName === "SVG" && n.attributes["aria-label"] === "Time to first token")).toBe(true);
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("every supported provider uses the same table and leaves unverified timings missing", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "modelSpeed").mockImplementation(async ({ account }) => {
    const p = { ...point("2026-10-25", 1, 0, 0), timed_calls: 0, long_calls: 0, first_token: { turns: 0, histogram: [] } };
    return { ...RESPONSE, account, models: [{ model: "fixture-model", total: p, points: [p] }] };
  });
  try {
    for (const provider of ["gemini", "grok", "glm", "claude"]) {
      await act(async () => root.render(<Speed {...props(provider, provider)} />));
      await flushUntil(() => dom.host.textContent.includes("Per model"));
      expect(nodes(dom.host).filter(n => n.attributes.title === "No verified first-token measurements").map(n => n.textContent)).toEqual(["—", "—"]);
    }
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("first-token columns show seconds, turn coverage and a dash for unverified sources", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const p = { ...point("2026-10-25", 50, 10000, 100000), first_token: { turns: 10, histogram: [[3731, 8], [5627, 1]] as Array<[number, number]> } };
  const read = spyOn(api, "modelSpeed").mockResolvedValue({ ...RESPONSE, models: [{ model: "fixture", total: p, points: [p] },
    { model: "unverified", total: point("total", 2, 0, 0), points: [point("2026-10-25", 2, 0, 0)] }] });
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(dom.host.textContent).toContain("First token · median");
    expect(dom.host.textContent).toContain("First token · P90");
    expect(dom.host.textContent).toContain("3.7 s");
    expect(dom.host.textContent).toContain("5.6 s");
    expect(nodes(dom.host).some(n => n.attributes.title === "9 of 10 completed turns measured · 90.0% coverage")).toBe(true);
    expect(nodes(dom.host).filter(n => n.attributes.title === "No verified first-token measurements").map(n => n.textContent)).toEqual(["—", "—"]);
    const medianTab = nodes(dom.host).find(n => n.tagName === "BUTTON" && n.textContent === "First token · median")!;
    await invoke(medianTab, "onClick");
    expect(nodes(dom.host).some(n => n.tagName === "SVG" && n.attributes["aria-label"] === "Time to first token")).toBe(true);
    expect(dom.host.textContent).toContain("3.7 s");
    await invoke(nodes(dom.host).find(n => n.tagName === "BUTTON" && n.textContent === "First token · P90")!, "onClick");
    expect(dom.host.textContent).toContain("5.6 s");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});
/** The matrix cell (named by its label) and the table name of one series, in that order. */
const toggles = (host: TestNode, label: string) => nodes(host).filter(node => node.tagName === "BUTTON"
  && (node.className.includes("speed-toggle") && node.textContent === label || node.className.includes("speed-cell") && node.attributes["aria-label"] === label));
function withStorage(storage: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return () => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); };
}

test("an unsupported subscription shows why without reading the endpoint", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "modelSpeed").mockResolvedValue(RESPONSE);
  try {
    await act(async () => root.render(<Speed {...props("unsupported", "unsupported")} />));
    expect(dom.host.textContent).toContain("No supported provider selected");
    // "All" without an active Claude or Codex subscription has nothing to read either.
    await act(async () => root.render(<Speed {...props(ALL_ACCOUNT, "codex")} cards={[card("unsupported", "unsupported")]} />));
    expect(dom.host.textContent).toContain("No supported subscription");
    expect(read).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("Speed opens with long calls, daily points and all history for a subscription and All", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = mockAll();
  try {
    for (const screenProps of [props("codex1", "codex"), allProps()]) {
      await act(async () => root.render(<Speed {...screenProps} />));
      await flushUntil(() => dom.host.textContent.includes("Per model"));
      const selected = nodes(dom.host).filter(node => node.tagName === "BUTTON"
        && node.attributes["aria-pressed"] === "true").map(node => node.textContent);
      expect(selected).toEqual(expect.arrayContaining(["long calls ≥256", "day", "all"]));
      expect(selected).not.toContain("week");
      expect(selected).not.toContain("all calls");
    }
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("a model hides from the legend or the table, on the chart only, and stays hidden after a reload", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom();
  const read = spyOn(api, "modelSpeed").mockResolvedValue(RESPONSE);
  let root = createRoot(dom.host as unknown as Element);
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    // The spark line sits above the others' scale.
    expect(dom.host.textContent).toContain("gpt-5.3-codex-spark ≈ 300 tok/s · above the scale ↑");
    expect(dom.host.textContent).toContain("Fastest model300 tok/sgpt-5.3-codex-spark");
    expect(dom.host.textContent).not.toContain("<synthetic>");
    expect(dom.host.textContent).toContain("Measured calls100.0%240 of 240 calls");
    await invoke(toggles(dom.host, "gpt-5.3-codex-spark")[0]!, "onClick");
    expect(toggles(dom.host, "gpt-5.3-codex-spark").map(node => node.attributes["aria-pressed"])).toEqual(["false", "false"]);
    expect(toggles(dom.host, "gpt-5.3-codex-spark").every(node => node.className.includes("is-off"))).toBe(true);
    expect(dom.host.textContent).not.toContain("above the scale");
    // Tiles and table still cover the hidden model.
    expect(dom.host.textContent).toContain("Fastest model300 tok/sgpt-5.3-codex-spark");
    expect(JSON.parse(values.get(HIDDEN_MODELS_KEY)!)).toEqual({ codex1: ["gpt-5.3-codex-spark"] });
    await act(async () => root.unmount());
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(toggles(dom.host, "gpt-5.3-codex-spark")[1]!.attributes["aria-pressed"]).toBe("false");
    await invoke(toggles(dom.host, "gpt-5.3-codex-spark")[1]!, "onClick");
    expect(toggles(dom.host, "gpt-5.3-codex-spark")[0]!.attributes["aria-pressed"]).toBe("true");
    expect(JSON.parse(values.get(HIDDEN_MODELS_KEY)!)).toEqual({});
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("fast series are dashed and deeper effort is darker, on the chart and in the matrix alike", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const variant = (speed: string, effort: string, calls: number) => ({ ...model("gpt-6.1-sol", [point("2026-10-05", calls, 4000, 100_000)]), speed, effort });
  const read = spyOn(api, "modelSpeed").mockResolvedValue({ ...RESPONSE, models: [variant("standard", "high", 90), variant("standard", "max", 80), variant("fast", "high", 70)] });
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    const cellLine = (label: string) => nodes(toggles(dom.host, label)[0]!).find(node => node.tagName === "LINE")!;
    expect(cellLine("gpt-6.1-sol · standard · high").attributes["stroke-dasharray"]).toBeUndefined();
    expect(cellLine("gpt-6.1-sol · fast · high").attributes["stroke-dasharray"]).toBe("5 3");
    const paths = nodes(dom.host).filter(node => node.tagName === "PATH");
    expect(paths.map(node => node.attributes["stroke-dasharray"] ?? "")).toEqual(["", "", "5 3"]);
    expect(paths[0]!.attributes.stroke).toBe("var(--codex)");
    expect(paths[1]!.attributes.stroke).toContain("calc(l - 0.16)");
    // The fast mode has its own section of the matrix.
    expect(dom.host.textContent).toContain("⚡ fast 1 models · 1 series");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("many series start as the busiest standard ones plus every fast one, and show all is remembered", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom();
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const models = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].flatMap((name, m) => efforts.map((effort, e) =>
    ({ ...model(name, [point("2026-10-05", 100 - m * 10 - e, 4000, 100_000)]), speed: "standard", effort })));
  models.push({ ...model("gpt-6.1-terra", [point("2026-10-05", 5, 4000, 100_000)]), speed: "fast", effort: "high" });
  const read = spyOn(api, "modelSpeed").mockResolvedValue({ ...RESPONSE, models });
  let root = createRoot(dom.host as unknown as Element);
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(dom.host.textContent).toContain("9 of 16 series on the chart");
    expect(toggles(dom.host, "gpt-6.1-terra · fast · high")[0]!.attributes["aria-pressed"]).toBe("true");
    expect(toggles(dom.host, "gpt-6-luna · standard · max")[0]!.attributes["aria-pressed"]).toBe("false");
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "show all")!, "onClick");
    expect(JSON.parse(values.get(HIDDEN_MODELS_KEY)!)).toEqual({ codex1: [] });
    await act(async () => root.unmount());
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(dom.host.textContent).toContain("16 of 16 series on the chart");
    // A column head toggles that effort in every model.
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.className.includes("speed-matrix-head") && node.textContent === "max")!, "onClick");
    expect(dom.host.textContent).toContain("13 of 16 series on the chart");
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("hiding works for the visit when storage throws, and show all brings every model back", async () => {
  setLanguage("en"); bustApiMemo();
  const denied = () => { throw new Error("storage denied"); };
  const restoreStorage = withStorage({ getItem: denied, setItem: denied });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "modelSpeed").mockResolvedValue(RESPONSE);
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(dom.host.textContent).not.toContain("show all");
    await invoke(toggles(dom.host, "gpt-5.6-sol")[1]!, "onClick");
    expect(toggles(dom.host, "gpt-5.6-sol")[0]!.attributes["aria-pressed"]).toBe("false");
    const showAll = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "show all")!;
    await invoke(showAll, "onClick");
    expect(toggles(dom.host, "gpt-5.6-sol").map(node => node.attributes["aria-pressed"])).toEqual(["true", "true"]);
    expect(dom.host.textContent).not.toContain("show all");
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("model labels follow a language switch on a mounted screen without reading again", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const response = { ...RESPONSE, models: [...RESPONSE.models, model("codex-auto-review", [point("2026-10-05", 60, 6000, 200_000)])] };
  const read = spyOn(api, "modelSpeed").mockResolvedValue(response);
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(toggles(dom.host, "Codex internal review")).toHaveLength(2);
    await act(async () => setLanguage("pl"));
    expect(dom.host.textContent).toContain("Według modeli");
    expect(toggles(dom.host, "Wewnętrzne review Codexa")).toHaveLength(2);
    expect(dom.host.textContent).not.toContain("Codex internal review");
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); setLanguage("en"); read.mockRestore(); dom.restore(); }
});

/** Three eligible subscriptions of "All"; a Gemini card and an inactive card are not read. */
const CARDS = [card(ALL_ACCOUNT, "all"), card("codex1", "codex"), card("codex2", "codex"), card("claude-a", "claude"),
  card("unsupported", "unsupported"), card("codex-old", "codex", false)];
const ANSWERS: Record<string, ModelSpeedResponse["models"]> = {
  // The same model in two subscriptions: 100 tok/s from 70 calls and 10 tok/s from 60 calls.
  codex1: [model("gpt-5.6-sol", [point("2026-10-05", 70, 70_000, 700_000)])],
  codex2: [model("gpt-5.6-sol", [point("2026-10-05", 60, 6_000, 600_000)]), model("gpt-6-luna", [point("2026-10-05", 50, 25_000, 500_000)])],
  "claude-a": [model("claude-opus-5", [point("2026-10-05", 60, 48_000, 600_000)]), model("<synthetic>", [point("2026-10-05", 9, 0, 9)])],
};
const allProps = () => ({ ...props(ALL_ACCOUNT, "all"), cards: CARDS });
/** Rows of the per-model table; the matrix legend's rows are left out. */
const tableRows = (host: TestNode) => {
  const legend = new Set(nodes(host).filter(node => node.className.includes("speed-matrix")).flatMap(nodes));
  return nodes(host).filter(node => node.tagName === "TR" && !legend.has(node));
};
const rowNames = (host: TestNode) => tableRows(host).slice(1)
  .map(row => row.children.slice(0, 3).map(cell => cell.textContent).join(" | "));
function mockAll(fail: string[] = []) {
  return spyOn(api, "modelSpeed").mockImplementation(async ({ account }) => {
    if (fail.includes(account)) throw new Error(`unknown account: ${account}`);
    return { ...RESPONSE, account, models: ANSWERS[account]! };
  });
}

test("All merges each model across the eligible subscriptions as a ratio of sums, or splits it by subscription", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = mockAll();
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(read.mock.calls.map(([query]) => query.account)).toEqual(["codex1", "codex2", "claude-a"]);
    expect(rowNames(dom.host)).toEqual(["gpt-5.6-sol | codex1@example.test, codex2@example.test | 130",
      "claude-opus-5 | claude-a@example.test | 60", "gpt-6-luna | codex2@example.test | 50"]);
    // 76,000 tokens in 1,300 s: 58.5 tok/s, where the average of the two subscriptions' speeds would be 55.
    const merged = tableRows(dom.host)[1]!;
    expect(merged.children.slice(4, 6).map(cell => cell.textContent)).toEqual(["58.5", "58.5"]);
    expect(dom.host.textContent).toContain("Subscriptions and models · 3 of 4");
    expect(dom.host.textContent).not.toContain("<synthetic>");
    const split = nodes(dom.host).find(node => node.tagName === "INPUT" && node.parentNode?.textContent === "split by subscription")!;
    await invoke(split, "onChange", { target: { checked: true } });
    expect(rowNames(dom.host).map(row => row.split(" | ")[0])).toEqual(["gpt-5.6-sol · codex1@example.test", "claude-opus-5 · claude-a@example.test",
      "gpt-5.6-sol · codex2@example.test", "gpt-6-luna · codex2@example.test"]);
    expect(JSON.parse(values.get(SPEED_SELECTION_KEY)!)).toMatchObject({ split: true });
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("the drawer narrows every part of All, persists without storage errors, and reads nothing again", async () => {
  setLanguage("en"); bustApiMemo();
  const denied = () => { throw new Error("storage denied"); };
  const restoreStorage = withStorage({ getItem: denied, setItem: denied });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = mockAll();
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    const open = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!;
    await invoke(open, "onClick");
    const dialog = nodes(dom.host).find(node => node.tagName === "DIALOG")!;
    expect(dialog.attributes.open).toBe("");
    const check = (label: string) => nodes(dialog).find(node => node.tagName === "INPUT" && node.attributes["aria-label"] === label)!;
    // One model of codex2 left out: the subscription is partly chosen and the merged row loses those calls.
    await invoke(check("codex / codex2@example.test · gpt-5.6-sol"), "onChange");
    const codex2 = check("codex / codex2@example.test");
    expect(codex2.attributes["aria-checked"]).toBe("mixed");
    expect((codex2 as unknown as { indeterminate: boolean }).indeterminate).toBe(true);
    expect(rowNames(dom.host)[0]).toBe("gpt-5.6-sol | codex1@example.test | 70");
    // Clearing both Codex subscriptions leaves Claude only: tiles and table follow the drawer.
    await invoke(check("codex / codex1@example.test"), "onChange");
    await invoke(codex2, "onChange"); // mixed selects all
    await invoke(check("codex / codex2@example.test"), "onChange");
    expect(rowNames(dom.host)).toEqual(["claude-opus-5 | claude-a@example.test | 60"]);
    expect(dom.host.textContent).toContain("Subscriptions and models · 1 of 4");
    expect(dom.host.textContent).toContain("Measured calls100.0%60 of 60 calls");
    const clearAll = nodes(dialog).find(node => node.tagName === "BUTTON" && node.attributes["aria-label"] === "Clear · all subscriptions")!;
    await invoke(clearAll, "onClick");
    expect(dom.host.textContent).toContain("No subscription or model is chosen");
    expect(read).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("a subscription that cannot be read is marked in the drawer while the others stay on screen", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = mockAll(["codex2"]);
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(rowNames(dom.host)).toEqual(["gpt-5.6-sol | codex1@example.test | 70", "claude-opus-5 | claude-a@example.test | 60"]);
    expect(dom.host.textContent).toContain("1 of 4 subscriptions could not be read");
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    const failed = nodes(dom.host).find(node => node.className.includes("speed-drawer-sub") && node.className.includes("is-failed"))!;
    expect(failed.textContent).toContain("codex / codex2@example.test");
    expect(failed.textContent).toContain("could not be read");
    expect(failed.textContent).toContain("unknown account: codex2");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("switching split keeps the chosen metric and grain, and the split checkbox stays the same element", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = mockAll();
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    const tab = (label: string) => nodes(dom.host).find(node => node.tagName === "BUTTON" && node.className.includes("ui-tab") && node.textContent === label)!;
    await invoke(tab("all calls"), "onClick");
    await invoke(tab("day"), "onClick");
    const split = nodes(dom.host).find(node => node.tagName === "INPUT" && node.parentNode?.textContent === "split by subscription")!;
    await invoke(split, "onChange", { target: { checked: true } });
    expect(rowNames(dom.host)[0]).toBe("gpt-5.6-sol · codex1@example.test | codex1@example.test | 70");
    expect([tab("all calls"), tab("day")].map(node => node.attributes["aria-pressed"])).toEqual(["true", "true"]);
    expect(nodes(dom.host).find(node => node.tagName === "INPUT" && node.parentNode?.textContent === "split by subscription")).toBe(split);
    await invoke(split, "onChange", { target: { checked: false } });
    expect([tab("all calls"), tab("day")].map(node => node.attributes["aria-pressed"])).toEqual(["true", "true"]);
    expect(rowNames(dom.host)[0]).toBe("gpt-5.6-sol | codex1@example.test, codex2@example.test | 130");
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

/** Answers on demand: each account's request stays pending until the test settles it. */
function deferredAll() {
  const waiting = new Map<string, { resolve: (value: ModelSpeedResponse) => void; signal?: AbortSignal }>();
  const read = spyOn(api, "modelSpeed").mockImplementation(({ account }, signal) => new Promise(resolve => {
    waiting.set(account, { resolve, signal });
  }));
  const answer = async (account: string) => { await act(async () => waiting.get(account)!.resolve({ ...RESPONSE, account, models: ANSWERS[account]! })); };
  return { read, waiting, answer };
}

test("All shows each subscription as it answers; one still pending holds back neither the report nor the drawer", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const { read, answer } = deferredAll();
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    expect(dom.host.textContent).toContain("Loading response times");
    expect(dom.host.textContent).toContain("Subscriptions and models");
    await answer("codex1");
    await answer("claude-a");
    // codex2 never answers here: the others are on screen, and the note and the drawer name it as loading.
    expect(rowNames(dom.host)).toEqual(["gpt-5.6-sol | codex1@example.test | 70", "claude-opus-5 | claude-a@example.test | 60"]);
    expect(dom.host.textContent).toContain("loading 1 of 4 subscriptions…");
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    const pending = nodes(dom.host).find(node => node.className.includes("speed-drawer-sub") && node.className.includes("is-pending"))!;
    expect(pending.textContent).toContain("codex / codex2@example.test");
    expect(pending.textContent).toContain("loading…");
    // Turning the pending subscription off ends the wait; its request is dropped, and so is an answer arriving later.
    const codex2 = nodes(pending).find(node => node.tagName === "INPUT")!;
    await invoke(codex2, "onChange");
    expect(dom.host.textContent).not.toContain("loading 1 of 4");
    await answer("codex2");
    expect(nodes(dom.host).find(node => node.className.includes("speed-drawer-sub") && node.textContent.includes("codex2@example.test"))!.textContent)
      .toContain("off · read when turned on");
    expect(rowNames(dom.host)[0]).toBe("gpt-5.6-sol | codex1@example.test | 70");
    expect(read).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("a new list of subscriptions aborts the previous requests and ignores their late answers", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const { read, waiting, answer } = deferredAll();
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    const first = waiting.get("codex1")!;
    // codex1 leaves the list before it answers.
    await act(async () => root.render(<Speed {...allProps()} cards={CARDS.filter(card => card.id !== "codex1")} />));
    expect(first.signal?.aborted).toBe(true);
    await answer("codex2");
    await answer("claude-a");
    await act(async () => first.resolve({ ...RESPONSE, account: "codex1", models: ANSWERS.codex1! }));
    expect(rowNames(dom.host)).toEqual(["claude-opus-5 | claude-a@example.test | 60", "gpt-5.6-sol | codex2@example.test | 60",
      "gpt-6-luna | codex2@example.test | 50"]);
    expect(dom.host.textContent).toContain("Subscriptions and models · 2 of 3");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("an inactive subscription is off and unread until turned on; then it is read and merged, and the choice is kept", async () => {
  setLanguage("en"); bustApiMemo();
  const values = new Map<string, string>();
  const restoreStorage = withStorage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const dom = installTestDom();
  let root = createRoot(dom.host as unknown as Element);
  const answers: Record<string, ModelSpeedResponse["models"]> = { ...ANSWERS, "codex-old": [model("gpt-5.6-sol", [point("2026-05-04", 30, 3_000, 300_000)])] };
  const read = spyOn(api, "modelSpeed").mockImplementation(async ({ account }) => ({ ...RESPONSE, account, models: answers[account]! }));
  const reads = () => read.mock.calls.map(([query]) => query.account);
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(reads()).toEqual(["codex1", "codex2", "claude-a"]);
    expect(dom.host.textContent).toContain("Subscriptions and models · 3 of 4");
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    const codexGroup = nodes(dom.host).find(node => node.tagName === "SECTION" && node.attributes["aria-label"] === "Codex")!;
    // Inactive subscriptions come after the active ones of their provider, marked and off.
    expect(nodes(codexGroup).filter(node => node.className.includes("speed-drawer-sub")).map(node => node.children[0]!.children[1]!.textContent))
      .toEqual(["codex / codex1@example.test", "codex / codex2@example.test", "codex / codex-old@example.test · inactive"]);
    const old = () => nodes(dom.host).find(node => node.tagName === "INPUT" && node.attributes["aria-label"] === "codex / codex-old@example.test")!;
    expect(old().attributes["aria-checked"]).toBe("false");
    await invoke(old(), "onChange");
    await flushUntil(() => reads().length === 4);
    expect(reads().at(-1)).toBe("codex-old");
    expect(rowNames(dom.host)[0]).toBe("gpt-5.6-sol | codex1@example.test, codex2@example.test +1 | 160");
    expect(dom.host.textContent).toContain("Subscriptions and models · 4 of 4");
    expect(JSON.parse(values.get(SPEED_SELECTION_KEY)!)).toMatchObject({ v: 2, optIn: ["codex-old"] });
    // A reload keeps it on.
    await act(async () => root.unmount());
    root = createRoot(dom.host as unknown as Element);
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model") && reads().length === 8);
    expect(reads().slice(4).sort()).toEqual(["claude-a", "codex-old", "codex1", "codex2"]);
    // Selecting all keeps it on with the others; nothing already read is read again.
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.attributes["aria-label"] === "Select all · all subscriptions")!, "onClick");
    expect(dom.host.textContent).toContain("Subscriptions and models · 4 of 4");
    expect(reads()).toHaveLength(8);
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("the drawer orders models by version and groups names within a version", async () => {
  setLanguage("en"); bustApiMemo();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const names = ["gpt-5.6-sol", "gpt-6-terra", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.3-codex"];
  const read = spyOn(api, "modelSpeed").mockImplementation(async ({ account }) => ({ ...RESPONSE, account,
    models: names.map(name => model(name, [point("2026-10-05", 10, 1000, 10000)])) }));
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    const group = nodes(dom.host).find(node => node.className === "speed-drawer-models")!;
    expect(group.children.map(row => row.children[1]!.textContent)).toEqual([
      "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-terra", "gpt-5.6-sol", "gpt-5.3-codex",
    ]);
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("with storage throwing, an inactive subscription turned on stays on for the visit only", async () => {
  setLanguage("en"); bustApiMemo();
  const denied = () => { throw new Error("storage denied"); };
  const restoreStorage = withStorage({ getItem: denied, setItem: denied });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const answers: Record<string, ModelSpeedResponse["models"]> = { ...ANSWERS, "codex-old": [model("gpt-old", [point("2026-05-04", 30, 3_000, 300_000)])] };
  const read = spyOn(api, "modelSpeed").mockImplementation(async ({ account }) => ({ ...RESPONSE, account, models: answers[account]! }));
  try {
    await act(async () => root.render(<Speed {...allProps()} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and models"))!, "onClick");
    await invoke(nodes(dom.host).find(node => node.tagName === "INPUT" && node.attributes["aria-label"] === "codex / codex-old@example.test")!, "onChange");
    await flushUntil(() => rowNames(dom.host).some(row => row.startsWith("gpt-old")));
    expect(dom.host.textContent).toContain("Subscriptions and models · 4 of 4");
  } finally { await act(async () => root.unmount()); read.mockRestore(); restoreStorage(); dom.restore(); }
});

test("a period narrows the tiles, the chart and the table, and an empty period says so", async () => {
  setLanguage("en"); bustApiMemo();
  setSystemTime(new Date("2026-10-30T12:00:00Z"));
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "modelSpeed").mockResolvedValue(RESPONSE);
  const tab = (label: string) => nodes(dom.host).find(node => node.tagName === "BUTTON" && node.className.includes("ui-tab") && node.textContent === label)!;
  try {
    await act(async () => root.render(<Speed {...props("codex1", "codex")} />));
    await flushUntil(() => dom.host.textContent.includes("Per model"));
    expect(tab("all").attributes["aria-pressed"]).toBe("true");
    expect(dom.host.textContent).toContain("Measured calls100.0%240 of 240 calls");
    expect(dom.host.textContent).toContain("whole history of the subscription");
    for (const days of [7, 14, 30, 60, 90, 180, 360]) {
      const label = days === 360 ? "360 days (year)" : `${days} days`;
      await invoke(tab(label), "onClick");
      expect(tab(label).attributes["aria-pressed"]).toBe("true");
    }
    expect(read).toHaveBeenCalledTimes(1);
    // The last 30 days start on 1 October: only the week of 5 October is left.
    await invoke(tab("30 days"), "onClick");
    expect(dom.host.textContent).toContain("Measured calls100.0%120 of 120 calls");
    expect(dom.host.textContent).toContain("last 30 days of the subscription");
    expect(dom.host.textContent).toContain("2026-10-05 … 2026-10-05");
    setSystemTime(new Date("2026-12-31T12:00:00Z"));
    await invoke(tab("90 days"), "onClick");
    await invoke(tab("30 days"), "onClick");
    expect(dom.host.textContent).toContain("No calls in the last 30 days");
    expect(tab("30 days").attributes["aria-pressed"]).toBe("true");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); setSystemTime(); }
});
