import { test, expect, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BillingCycle, BillingCyclesAccount } from "../../shared/billing-cycles";
import { api, type ApiAccount } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { installTestDom, flushUntil, invoke, findByAttribute, type TestNode } from "../lib/test-dom-harness";
import { emptyModel } from "../lib/cycle";
import type { RosterCard } from "../lib/roster";
import type { ScreenProps } from "../lib/screens";
import { allSubscriptions, monthRow, perDollar, perWindowPct, periodCycles, pointsFallback, readMonthState, summarize, writeMonthState, MONTH_STATE_KEY } from "../lib/subscription-month";
import { SubscriptionMonth } from "./SubscriptionMonth";
import { Capacity } from "../screens/Capacity";
import { Value } from "../screens/Value";

function findAll(node: TestNode, predicate: (node: TestNode) => boolean): TestNode[] {
  return [...predicate(node) ? [node] : [], ...node.children.flatMap(child => findAll(child, predicate))];
}
const button = (root: TestNode, text: string) => findAll(root, node => node.tagName === "BUTTON" && node.textContent.startsWith(text))[0]!;
const units = (total: number) => ({ input: total * 0.9, cached: total * 0.6, output: total * 0.1, total });
// The summary's figures (KpiStrip) watch the breakpoint, which needs animation frames.
globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};
const withAttribute = (root: TestNode, name: string) => findAll(root, (node) => node.getAttribute(name) !== null)[0] ?? null;
const summaryText = (root: TestNode) => withAttribute(root, "data-summary")!.textContent;
/** A tooltip that starts with the given words: breakdowns and warnings live in tooltips, not on screen. */
const titled = (root: TestNode, start: string) => findAll(root, (node) => (node.getAttribute("title") ?? "").startsWith(start))[0]?.getAttribute("title") ?? null;
const warnings = (root: TestNode) => withAttribute(root, "data-cycle-warnings")?.getAttribute("title") ?? "";

/** The current cycle: 400 points worth $4000; 2 provider resets (+1 window) and 1 banked (+0.5) inside; $2000 used. */
const current: BillingCycle = {
  start: "2026-09-24T09:55:57.164Z", end: "2026-10-24T09:55:57.164Z", plan: "pro", basis: "observed", anchor_uncertain: false, cycle_months: 1,
  shortened: false, current: true, price: { amount: 200, currency: "USD", source: "catalog" }, catalog_usd: 200,
  windows: { share: 3.9, idle: 0.1, touched: 4, observed_share: 1 }, used_pp: 200, used_pct: 50, api_usd: 2000, capacity_usd: 4000,
  capacity: { pp: 400, factor: 1, api_usd: 4000, tokens: units(40_000_000), credits: { low: 80_000, high: 100_000 },
    calibration: { counter: "w", plan: "pro", windows: 3, inside: 2, pp: 240, from: "2026-09-20T00:00:00.000Z", until: "2026-10-10T00:00:00.000Z", scope: null,
      outliers: { count: 1, starts: ["2026-10-07T06:19:11.000Z"] } } },
  used_units: { api_usd: 2000, tokens: units(20_000_000), credits: { low: 40_000, high: 50_000 } },
  resets: {
    provider: { count: 2, windows: 1, pp: 100, api_usd: 1000, tokens: units(10_000_000), credits: { low: 20_000, high: 25_000 } },
    banked: { count: 1, windows: 0.5, pp: 50, api_usd: 500, tokens: units(5_000_000), credits: { low: 10_000, high: 12_500 }, origins: { all_accounts: 0, unknown: 1 } },
    scheduled: { count: 1, windows: 0, pp: 0, api_usd: 0, tokens: units(0), credits: { low: 0, high: 0 } },
    not_reset: { count: 1, windows: 0, pp: 0, api_usd: 0, tokens: units(0), credits: { low: 0, high: 0 } },
  },
  to_date: { windows: 3, used_pct: 66.7 }, projection: { windows_min: 5, used_pct: 40 }, per_window_point: 0.5, unmetered: null, others: [],
  flags: ["capacity_borrowed_windows", "capacity_outliers_excluded"], run: { from: "2026-09-09T00:00:00.000Z", anchor: "2026-09-09T00:00:00.000Z", until: null }, declared_from: null,
};
/** An older cycle without a calibration: its capacity is unknown, never 0. */
const older: BillingCycle = { ...current, start: "2026-08-24T09:55:57.164Z", end: "2026-09-24T09:55:57.164Z", current: false, capacity: null, capacity_usd: null,
  resets: { single: { count: 1, windows: 0.25, pp: 25, api_usd: null, tokens: null, credits: null } }, to_date: null, projection: null,
  flags: ["capacity_uncalibrated"] };
const view = (provider: string, account: string): BillingCyclesAccount => ({ provider, account, counter: "w", stale: false, cycles: [older, current] });

test("rows split capacity into base and reset bonuses; totals follow the switched-on kinds", () => {
  const all = monthRow(current, "api", new Set(["automatic", "unidentified", "banked", "single"]));
  expect(all).toMatchObject({ base: 2500, total: 4000, usedPct: 50 });
  expect(all.bonuses.automatic).toEqual({ count: 2, carried: 0, value: 1000 });
  const noBanked = monthRow(current, "api", new Set(["automatic", "unidentified", "single"]));
  expect(noBanked.total).toBe(3500);
  expect(noBanked.usedPct).toBeCloseTo(2000 / 3500 * 100, 9);
  // Credits are the middle of the range; window points exist without a calibration.
  expect(monthRow(current, "credits", new Set()).base).toBe(90_000 - 22_500 - 11_250);
  expect(monthRow(older, "pp", new Set(["single"]))).toMatchObject({ base: 375, total: 400 });
  expect(monthRow(older, "api", new Set(["single"]))).toMatchObject({ base: null, total: null, usedPct: null });
  // The remembered choice survives only what is valid.
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } as unknown as Storage;
  writeMonthState({ unit: "pp", off: ["banked"], period: "all" }, storage);
  expect(readMonthState(storage)).toEqual({ unit: "pp", off: ["banked"], period: "all" });
  store.set(MONTH_STATE_KEY, JSON.stringify({ unit: "euros", off: ["banked", "nonsense"] }));
  expect(readMonthState(storage)).toEqual({ unit: "api", off: ["banked"], period: "current" });
});

test("the subscription month shows counts per kind, switches kinds and units, and keeps unknown capacity as —", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue(view("codex", "codex1"));
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="codex" account="codex1" dataRevision={1} />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    // Short toggle labels; the full name is the title.
    expect(button(dom.host, "Automatic").textContent).toBe("Automatic 2");
    expect(button(dom.host, "Automatic").getAttribute("title")).toBe("Automatic (provider)");
    expect(button(dom.host, "Banked").textContent).toBe("Banked 1");
    expect(button(dom.host, "Single").textContent).toBe("Single 1");
    const row = () => findByAttribute(dom.host, "data-cycle-row", current.start)!;
    // The shared columns (user decision 21.10): paid in USD, capacity, used, used %, unused, return and potential per $1;
    // the reset split starts hidden.
    expect(row().textContent).toBe("09/24–10/24ongoingPro · ×20$200 cat.$4,000$2,00050%to date 67%$2,00010×20×");
    expect(findAll(row(), node => node.getAttribute("data-resets") !== null)).toEqual([]);
    expect(titled(row(), "Used $2,000 ÷ paid $200")).toBe("Used $2,000 ÷ paid $200 · 1 cycle");
    // The value chart has the same row: used and capacity per $1 against the 1× line.
    expect(findByAttribute(dom.host, "data-value-bar", current.start)!.textContent).toContain("10× / 20×");
    // Switching banked off: the total, the share used and the potential follow.
    await invoke(button(dom.host, "Banked"), "onClick");
    expect(button(dom.host, "Banked").getAttribute("aria-pressed")).toBe("false");
    expect(row().textContent).toContain("$3,500");
    expect(row().textContent).toContain("57%");
    expect(row().textContent).toContain("$1,50010×18×");
    // Window points: total 350 without banked, 200 used, 150 unused.
    await invoke(button(dom.host, "Window points"), "onClick");
    expect(row().textContent).toContain("350 pp");
    expect(row().textContent).toContain("150 pp");
    // The older cycle has no calibration: its money values are unknown, with the reason in the title.
    await invoke(button(dom.host, "API $"), "onClick");
    const old = findByAttribute(dom.host, "data-cycle-row", older.start)!;
    const base = findAll(old, node => node.tagName === "TD")[3]!;
    expect(base.textContent).toBe("—");
    expect(base.getAttribute("title")).toBe("No capacity: no calibration for this plan yet");
    // Details of the current cycle (selected by default): calibration, outliers; the plain-word flags behind one marker.
    expect(dom.host.textContent).toContain("3 windows (2 inside the cycle, 1 borrowed)");
    expect(dom.host.textContent).toContain("Outliers left out");
    expect(dom.host.textContent).not.toContain("the nearest windows of the same plan were added");
    expect(withAttribute(dom.host, "data-cycle-warnings")!.textContent).toBe("2 warnings");
    expect(warnings(dom.host)).toContain("the nearest windows of the same plan were added");
    expect(dom.host.textContent).toContain("origin unknown 1");
    // Choosing the older row shows its details.
    await invoke(old, "onClick");
    expect(warnings(dom.host)).toContain("No window of this plan can calibrate the capacity yet.");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("a Claude subscription has no credits unit and its capacity is a lower bound", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const claude = { ...current, capacity: { ...current.capacity!, credits: null, calibration: { ...current.capacity!.calibration, scope: "observed_partial_traffic" } } };
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue({ provider: "claude", account: "claude-ea41", counter: "w", stale: true, cycles: [claude] });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="anthropic" account="Claude-EA41" />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    // The same units as Codex; credits stay visible but disabled, with the reason.
    const credits = findAll(dom.host, node => node.tagName === "BUTTON" && node.textContent === "Credits")[0]!;
    expect(credits.getAttribute("disabled")).not.toBeNull();
    expect(credits.getAttribute("title")).toBe("Credits are a Codex unit");
    expect(warnings(dom.host)).toContain("the capacity is a lower bound");
    expect(dom.host.textContent).toContain("Updating in the background");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("Value → Billing periods serves one subscription and all of them; Capacity keeps only the global comparison for all", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const account = { id: "codex1", vendor: "codex", plan: "pro", login: "codex1", machine: null, note: null, homes: [], ratelimit_rows: 0, event_rows: 0, windows: [],
    limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true } as unknown as ApiAccount;
  const card = { id: "codex1", active: true, group: "codex", vendor: "codex" } as RosterCard;
  const props = (id: string): ScreenProps => ({ model: emptyModel(id, 10080), account: id, accounts: [account], card, capabilities: null,
    project: "", projects: [], unit: "percent", chosen: null, compare: [], windowRailInShell: false, sync: null,
    setUnit() {}, setProject() {}, selectAccount() {}, selectCycle() {}, openDrawer() {}, goto() {}, setCompare() {}, triggerSync() {} });
  // Other reads of the screen (global comparison, subscription analysis) never answer here.
  Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
  const cycles = spyOn(api, "capacityCycles").mockImplementation(() => new Promise(() => {}));
  const accounting = spyOn(api, "codexAccounting").mockImplementation(() => new Promise(() => {}));
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue(view("codex", "codex1"));
  const readAll = spyOn(api, "billingCycles").mockResolvedValue({ accounts: [view("codex", "codex1")] });
  setLanguage("en");
  try {
    // IA-2026-10-19 v1.1: the scope tabs are gone; all subscriptions mean the global comparison.
    await act(async () => root.render(<Capacity {...props("__all__")} cards={[card]} />));
    expect(dom.host.textContent).toContain("Global subscription capacity");
    expect(dom.host.textContent).not.toContain("Subscription month");
    await act(async () => root.render(<Value {...props("__all__")} view="periods" cards={[card]} />));
    await flushUntil(() => findByAttribute(dom.host, "data-subscription-row", "codex|codex1") !== null);
    await act(async () => root.render(<Value {...props("codex1")} view="periods" cards={[card]} />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; cycles.mockRestore(); accounting.mockRestore(); read.mockRestore(); readAll.mockRestore(); dom.restore(); }
});

test("before the first cycles are stored the scope shows the preparing state and reads again until they arrive", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  let calls = 0;
  const read = spyOn(api, "billingCyclesOf").mockImplementation(async () => (++calls === 1
    ? { provider: "codex", account: "codex1", counter: null, stale: true, cycles: [] } : view("codex", "codex1")));
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="codex" account="codex1" />));
    await flushUntil(() => dom.host.textContent.includes("Preparing billing cycles"));
    expect(dom.host.textContent).not.toContain("No billing cycles");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4100)); });
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    expect(calls).toBe(2);
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("the token split of the capacity follows the switched-on kinds", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue(view("codex", "codex1"));
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="codex" account="codex1" />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    // All on: the capacity's own split (36M input of 40M tokens).
    expect(findByAttribute(dom.host, "data-tokens", "capacity")!.textContent).toContain("36M");
    // Banked off: its 5M tokens (4.5M input) leave the split.
    await invoke(button(dom.host, "Banked"), "onClick");
    expect(findByAttribute(dom.host, "data-tokens", "capacity")!.textContent).toContain("31.5M");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("the summary of one subscription: current, previous and whole period, a selected row, toggles and uncalibrated cycles", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const withWindows: BillingCycle = { ...current, main_windows: [
    { start: "2026-09-24T10:00:00.000Z", end: "2026-10-01T10:00:00.000Z", cause: "provider", used_pp: 45, share: 1, capacity_share: 0.25 },
    { start: "2026-10-01T10:00:00.000Z", end: "2026-10-03T10:00:00.000Z", cause: "not_reset", used_pp: 25.4, share: 0.5, capacity_share: 0.125 },
  ] };
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue({ provider: "codex", account: "codex1", counter: "w", stale: false, cycles: [older, withWindows] });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="codex" account="codex1" />));
    await flushUntil(() => dom.host.textContent.includes("Subscription capacity vs usage"));
    // Current cycle (the default): the table's Total and Used, what is left, the share, the price and the projection.
    expect(findByAttribute(dom.host, "data-period", "current")!.getAttribute("aria-pressed")).toBe("true");
    let text = summaryText(dom.host);
    expect(text).toContain("Current cycle");
    for (const part of ["$4,000", "$2,000", "50%", "$200 cat.", "to date 67% · minimal projection 40%"]) expect(text).toContain(part);
    // One row of four headline numbers; what is unused and the average per window are tooltips.
    expect(text).not.toContain("Unused");
    expect(titled(dom.host, "Unused")).toBe("Unused $2,000");
    expect(titled(dom.host, "Average use per window")).toContain("51%");
    // The period choice names the period; the dates are the heading's tooltip.
    expect(text).not.toContain("Current cycle ·");
    // The tab already names the screen; explanations live in the help dot, not on screen (user decision 17.10).
    expect(dom.host.textContent).not.toContain("Subscription month");
    expect(dom.host.textContent).not.toContain("on average");
    expect(withAttribute(dom.host, "data-excluded")).toBeNull();
    // What the resets added: the base and the bonuses by kind, in the capacity's tooltip.
    expect(text).not.toContain("Without early resets");
    expect(titled(dom.host, "Without early resets")).toContain("Without early resets $2,500 · resets added +$1,500");
    expect(titled(dom.host, "Without early resets")).toContain("Banked +$500");
    // A reset kind switched off lowers the capacity and raises the share; its bonus is named as not counted, not added.
    await invoke(button(dom.host, "Banked"), "onClick");
    text = summaryText(dom.host);
    expect(titled(dom.host, "Without early resets")).toContain("resets added +$1,000");
    expect(titled(dom.host, "Without early resets")).toContain("Banked +$500 (not counted)");
    expect(text).toContain("$3,500");
    expect(titled(dom.host, "Unused")).toBe("Unused $1,500");
    expect(text).toContain("57%");
    // Previous cycle: no calibration, so no capacity and its usage left out too, with a note.
    await invoke(findByAttribute(dom.host, "data-period", "previous")!, "onClick");
    text = summaryText(dom.host);
    expect(text).toContain("Previous cycle");
    expect(text).toContain("1 cycle without calibration not included");
    expect(text).not.toContain("$2,000");
    // Whole period: only the calibrated cycle in both sums; paid adds both cycles in their one currency.
    await invoke(findByAttribute(dom.host, "data-period", "all")!, "onClick");
    text = summaryText(dom.host);
    for (const part of ["Whole period", "$3,500", "$2,000", "57%", "$400 cat.", "1 cycle without calibration not included"]) expect(text).toContain(part);
    expect(titled(dom.host, "Whole period ·")).toContain("2 cycles");
    // A clicked row is shown until a period is chosen again.
    await invoke(findByAttribute(dom.host, "data-cycle-row", current.start)!, "onClick");
    text = summaryText(dom.host);
    expect(text).toContain("Selected cycle");
    expect(findAll(dom.host, (node) => node.getAttribute("data-period") !== null && node.getAttribute("aria-pressed") === "true")).toEqual([]);
    expect(text).not.toContain("2 cycles");
    // The cycle's windows from reset to reset, with how each ended, its use before the end and its part of the capacity.
    const windows = findAll(dom.host, (node) => node.getAttribute("data-window") !== null);
    expect(windows.map((node) => node.getAttribute("data-cause"))).toEqual(["provider", "not_reset"]);
    expect(windows[0]!.textContent).toContain("Provider reset");
    expect(windows[0]!.textContent).toContain("45%");
    expect(windows[0]!.textContent).toContain("25%");
    expect(windows[1]!.textContent).toContain("Continued (no reset)");
    expect(windows[1]!.textContent).toContain("12.5%");
    expect(findAll(dom.host, (node) => node.getAttribute("data-strip-window") !== null).length).toBe(2);
    await invoke(findByAttribute(dom.host, "data-period", "current")!, "onClick");
    expect(summaryText(dom.host)).toContain("Current cycle");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("Value billing periods opens the chosen cycle's Settings windows and restores it on return", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const withWindows = (cycle: BillingCycle): BillingCycle => ({ ...cycle, main_windows: [
    { start: cycle.start, end: cycle.end, cause: "unknown", used_pp: 100, share: 1, capacity_share: 0.25 }] });
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue({ ...view("codex", "codex1"), cycles: [withWindows(older), withWindows(current)] });
  const opened: import("../lib/data-settings").DataSettingsTarget[] = [];
  const props: ScreenProps = { model: emptyModel("codex1", 10080), account: "codex1", accounts: [], card: { group: "codex" } as RosterCard, capabilities: null,
    project: "", projects: [], unit: "percent", chosen: null, compare: [], windowRailInShell: false, sync: null,
    setUnit() {}, setProject() {}, selectAccount() {}, selectCycle() {}, openDrawer() {}, goto() {}, setCompare() {}, triggerSync() {},
    openDataSettings: (target) => opened.push(target) };
  setLanguage("en");
  try {
    await act(async () => root.render(<Value {...props} view="periods" cards={[]} />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    await invoke(findByAttribute(dom.host, "data-cycle-row", older.start)!, "onClick");
    await invoke(button(dom.host, "Edit windows"), "onClick");
    expect(opened).toEqual([{ area: "windows", account: "codex1", cycle: { start: older.start, end: older.end } }]);
    await act(async () => root.render(<div />));
    await act(async () => root.render(<Value {...props} view="periods" cards={[]} dataSettings={{ ...opened[0]!, returnScreen: "periods" }} />));
    await flushUntil(() => dom.host.textContent.includes("Capacity of each cycle"));
    expect(findByAttribute(dom.host, "data-cycle-row", older.start)!.getAttribute("aria-selected")).toBe("true");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

/** A Claude subscription paid in euros: no credits, its own capacity. */
const claudeCycle: BillingCycle = { ...current, price: { amount: 90, currency: "EUR", source: "declared" },
  capacity: { ...current.capacity!, credits: null }, used_units: { ...current.used_units!, credits: null },
  resets: { provider: { ...current.resets!.provider!, credits: null } } };
/** A subscription that ended in the summer: its last cycle is long over, never current. */
const endedCycle: BillingCycle = { ...older, start: "2026-06-11T00:00:00.000Z", end: "2026-07-11T00:00:00.000Z", price: { amount: 100, currency: "USD", source: "declared" } };
const NOW = Date.parse("2026-10-11T12:00:00Z");

test("periods: the current cycle only when current now; the previous one before it, or one that ended within 35 days", () => {
  const ended = (end: string): BillingCycle => ({ ...older, start: "2026-08-20T00:00:00.000Z", end, current: false });
  expect(periodCycles([older, current], "current", NOW)).toEqual([current]);
  expect(periodCycles([older, current], "previous", NOW)).toEqual([older]);
  // An ended subscription has no current cycle; its last one is previous only while it ended recently.
  expect(periodCycles([endedCycle], "current", NOW)).toEqual([]);
  expect(periodCycles([ended("2026-09-18T00:00:00.000Z")], "previous", NOW).length).toBe(1);
  expect(periodCycles([ended("2026-09-01T00:00:00.000Z")], "previous", NOW)).toEqual([]);
  expect(periodCycles([endedCycle], "all", NOW)).toEqual([endedCycle]);
});

test("usage not stored in the unit reads as unknown, never 0, and leaves the cycle out of both sums", () => {
  const all = new Set(["automatic", "unidentified", "banked", "single"] as const);
  const unseen: BillingCycle = { ...current, flags: [...current.flags, "window_traffic_unseen"] };
  expect(monthRow(unseen, "api", all).used.value).toBeNull();
  expect(monthRow(unseen, "pp", all).used.value).toBe(200);
  const summary = summarize([unseen, { ...current, start: "2026-10-24T09:55:57.164Z", current: false }], "api", all);
  expect(summary).toMatchObject({ capacity: 4000, used: 2000, uncalibrated: 0, usageUnknown: 1 });
});

test("per dollar: used and capacity ÷ USD paid, each over the cycles where both are known; no rate or a zero price leave a cycle out", () => {
  const all = new Set(["automatic", "unidentified", "banked", "single"] as const);
  const euro: BillingCycle = { ...current, price: { amount: 90, currency: "EUR", source: "declared" } };
  const free: BillingCycle = { ...current, price: { amount: 0, currency: "USD", source: "catalog" } };
  const unseen: BillingCycle = { ...current, flags: [...current.flags, "window_traffic_unseen"] };
  // Usage counts without a calibration (older); a capacity counts without stored usage (unseen).
  expect(perDollar([current, older, euro, free, unseen], "api", all)).toEqual({ used: 10, capacity: 20,
    usedSum: 4000, usedPaid: 400, usedCycles: 2, capacitySum: 8000, capacityPaid: 400, capacityCycles: 2 });
  expect(perDollar([{ ...euro, price: { ...euro.price, usd: 100 } }], "tokens", all)).toMatchObject({ used: 200_000, capacity: 400_000 });
  expect(perDollar([euro, free], "api", all)).toMatchObject({ used: null, capacity: null });
});

test("all subscriptions: sums per period, what resets added, credits over Codex only, no window points, currencies never mixed", async () => {
  const all = new Set(["automatic", "unidentified", "banked", "single"] as const);
  const accounts = [view("codex", "codex1"), { provider: "claude", account: "claude-ea41", counter: "w", stale: false, cycles: [claudeCycle] },
    { provider: "claude", account: "claude-2e09", counter: "w", stale: false, cycles: [endedCycle] },
    { provider: "codex", account: "codex1::business", counter: null, stale: false, cycles: [current] }];
  const api$ = allSubscriptions(accounts, "current", "api", all, NOW);
  // The ended subscription has no current cycle: not summed, not paid, listed apart.
  expect(api$.rows.map((row) => row.account)).toEqual(["claude-ea41", "codex1"]);
  expect(api$.empty).toEqual([{ provider: "claude", account: "claude-2e09" }]);
  // Each subscription's Total: the capacity with its bonuses (4000 each); Claude's base 3000 + 1000, Codex 2500 + 1500.
  expect(api$.total).toMatchObject({ capacity: 8000, used: 4000, base: 5500, uncalibrated: 0, utilisation: 50 });
  expect(api$.total.bonuses).toEqual({ automatic: 2000, unidentified: 0, banked: 500, single: 0 });
  expect(api$.total.paid).toEqual([{ currency: "EUR", amount: 90, catalog: false }, { currency: "USD", amount: 200, catalog: true }]);
  const credits = allSubscriptions(accounts, "current", "credits", all, NOW);
  expect(credits.rows.map((row) => row.account)).toEqual(["codex1"]);
  expect(credits.total.capacity).toBe(90_000);
  const whole = allSubscriptions(accounts, "all", "api", all, NOW);
  expect(whole.empty).toEqual([]);
  expect(whole.total).toMatchObject({ capacity: 8000, used: 4000, uncalibrated: 2 });
  expect(whole.total.paid).toEqual([{ currency: "EUR", amount: 90, catalog: false }, { currency: "USD", amount: 100, catalog: false }, { currency: "USD", amount: 400, catalog: true }]);
  expect(perWindowPct(whole.total)).toBeCloseTo(800 / 15.6, 6);
  expect(summarize([older], "api", all).capacity).toBeNull();
  // Without the euro payment's NBP rate the total stays per currency; with it, one sum in USD.
  expect(whole.total).toMatchObject({ paidUsd: null, paidUsdMissing: 1 });
  const converted = allSubscriptions(accounts.map((entry) => ({ ...entry, cycles: entry.cycles.map((cycle) => cycle.price.currency === "EUR"
    ? { ...cycle, price: { ...cycle.price, usd: 104.5 } } : cycle) })), "all", "api", all, NOW);
  expect(converted.total).toMatchObject({ paidUsd: 604.5, paidUsdMissing: 0 });
  // A repeated payment is a payment, not a catalog price.
  expect(summarize([{ ...older, price: { amount: 813, currency: "PLN", source: "repeated", usd: 219.73 } }], "api", all))
    .toMatchObject({ paid: [{ currency: "PLN", amount: 813, catalog: false }], paidUsd: 219.73 });

  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "billingCycles").mockResolvedValue({ accounts: accounts.map((entry) => entry.account === "claude-2e09" ? entry
    : { ...entry, cycles: entry.cycles.map((cycle) => ({ ...cycle, current: cycle.start === current.start })) }) });
  const selected: string[] = [];
  const cards = [{ id: "codex1", vendor: "codex", group: "codex", vendorAccount: "account_0006@example.test", plan: "pro" },
    { id: "Claude-EA41", vendor: "claude", group: "claude", vendorAccount: "sample_a@example.test", plan: "max" },
    { id: "claude-2e09", vendor: "claude", group: "claude", vendorAccount: "old@example.test", plan: null }] as unknown as RosterCard[];
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="all" account="all" all={{ cards, select: (id) => void selected.push(id) }} />));
    await flushUntil(() => dom.host.textContent.includes("Subscription capacity vs usage"));
    // The same units as one subscription; window points stay visible but disabled, with the reason.
    expect(button(dom.host, "Window points").getAttribute("disabled")).not.toBeNull();
    expect(button(dom.host, "Window points").getAttribute("title")).toBe("Window points do not add up across subscriptions");
    expect(findByAttribute(dom.host, "data-subscription-row", "codex|codex1::business")).toBeNull();
    let text = summaryText(dom.host);
    expect(text).toContain("$8,000");
    expect(titled(dom.host, "Without early resets")).toContain("Without early resets $5,500 · resets added +$2,500\nAutomatic (provider) +$2,000");
    expect(text).toContain("90 € · $200 cat.");
    expect(text).not.toContain("$100");
    // The rail's name and product · plan, not the raw id.
    const codex = findByAttribute(dom.host, "data-subscription-row", "codex|codex1")!;
    expect(codex.textContent).toContain("account_0006@example.test");
    expect(codex.textContent).toContain("OpenAI / Codex · ");
    expect(codex.textContent).not.toContain("codex1");
    // The plan of the cycle in the vendor's ink, then the shared columns: paid, capacity, used, used %, unused, return, potential.
    expect(codex.textContent).toContain("OpenAI / Codex · Pro · ×20$200 cat.$4,000$2,00050%$2,00010×20×");
    // A payment without its NBP rate has no dollar value yet: no return, no bar.
    const claude = findByAttribute(dom.host, "data-subscription-row", "claude|claude-ea41")!;
    expect(claude.textContent).toContain("90 €$4,000$2,00050%$2,000——");
    expect(findByAttribute(dom.host, "data-value-bar", "codex|codex1")!.textContent).toContain("10× / 20×");
    expect(findByAttribute(dom.host, "data-value-bar", "claude|claude-ea41")).toBeNull();
    expect(summaryText(dom.host)).toContain("Return10×");
    // The ended subscription: one quiet line under the table, no row.
    expect(findByAttribute(dom.host, "data-subscription-row", "claude|claude-2e09")).toBeNull();
    expect(withAttribute(dom.host, "data-no-cycle-subscriptions")!.textContent).toBe("No cycle in this period: old@example.test");
    await invoke(findByAttribute(dom.host, "data-subscription-row", "claude|claude-ea41")!, "onClick");
    expect(selected).toEqual(["Claude-EA41"]);
    // A switched-off kind leaves what the resets added and is named as not counted in the split.
    await invoke(button(dom.host, "Banked"), "onClick");
    expect(titled(dom.host, "Without early resets")).toContain("resets added +$2,000");
    expect(titled(dom.host, "Without early resets")).toContain("Banked +$500 (not counted)");
    await invoke(button(dom.host, "Banked"), "onClick");
    // Whole period: the ended subscription is a row.
    await invoke(findByAttribute(dom.host, "data-period", "all")!, "onClick");
    expect(findByAttribute(dom.host, "data-subscription-row", "claude|claude-2e09")).not.toBeNull();
    expect(withAttribute(dom.host, "data-no-cycle-subscriptions")).toBeNull();
    await invoke(findByAttribute(dom.host, "data-period", "current")!, "onClick");
    // Credits: the Codex subscriptions only, said in the heading.
    await invoke(button(dom.host, "Credits"), "onClick");
    text = summaryText(dom.host);
    expect(text).toContain("Codex only");
    expect(findByAttribute(dom.host, "data-subscription-row", "claude|claude-ea41")).toBeNull();
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("one subscription: usage not stored reads — with its points; an ended subscription has no current cycle", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const unseen: BillingCycle = { ...current, flags: [...current.flags, "window_traffic_unseen"] };
  const read = spyOn(api, "billingCyclesOf").mockResolvedValue({ provider: "codex", account: "codex2", counter: "w", stale: false, cycles: [unseen] });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="codex" account="codex2" />));
    await flushUntil(() => dom.host.textContent.includes("Subscription capacity vs usage"));
    const row = findByAttribute(dom.host, "data-cycle-row", current.start)!;
    const used = findAll(row, (node) => node.tagName === "TD")[4]!;
    expect(used.textContent).toBe("—");
    expect(used.getAttribute("title")).toBe("Usage in this unit not stored for some windows; points used: 200");
    expect(summaryText(dom.host)).toContain("1 cycle without stored usage in this unit not included");
    expect(warnings(dom.host)).toContain("no traffic stored on this machine");
    // The summary falls back to window points, marked as such: 400 pp capacity (250 base + 150 from resets), 200 pp used.
    const text = summaryText(dom.host);
    for (const part of ["4 windows", "200 pp", "50%", "$200 cat."]) expect(text).toContain(part);
    expect(titled(dom.host, "Without early resets")).toContain("Without early resets 2.5 windows · resets added +1.5 windows");
    expect(withAttribute(dom.host, "data-points-fallback")!.textContent).toContain("In window points");
    // The toggles act on the points too: banked off leaves 3.5 windows.
    await invoke(button(dom.host, "Banked"), "onClick");
    expect(summaryText(dom.host)).toContain("3.5 windows");
    expect(summaryText(dom.host)).toContain("57%");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
  const dom2 = installTestDom(), root2 = createRoot(dom2.host as unknown as Element);
  const ended = spyOn(api, "billingCyclesOf").mockResolvedValue({ provider: "claude", account: "claude-2e09", counter: "w", stale: false, cycles: [endedCycle] });
  try {
    await act(async () => root2.render(<SubscriptionMonth vendor="claude" account="claude-2e09" />));
    await flushUntil(() => dom2.host.textContent.includes("Subscription capacity vs usage"));
    expect(withAttribute(dom2.host, "data-no-cycle")!.textContent).toBe("No cycle in this period.");
    expect(summaryText(dom2.host)).not.toContain("$100");
    await invoke(findByAttribute(dom2.host, "data-period", "all")!, "onClick");
    expect(summaryText(dom2.host)).toContain("$100");
  } finally { await act(async () => root2.unmount()); ended.mockRestore(); dom2.restore(); }
});

test("all subscriptions: a subscription whose usage in the unit is unknown shows window points, never summed with the unit", async () => {
  const unseen: BillingCycle = { ...current, flags: [...current.flags, "window_traffic_unseen"] };
  const accounts = [view("codex", "codex1"), { provider: "codex", account: "codex2", counter: "w", stale: false, cycles: [unseen] }];
  const all = new Set(["automatic", "unidentified", "banked", "single"] as const);
  const sums = allSubscriptions(accounts, "current", "api", all, NOW);
  expect(sums.total).toMatchObject({ capacity: 4000, used: 2000, usageUnknown: 1 });
  expect(pointsFallback([unseen], "api", all)).toMatchObject({ capacity: 400, used: 200, base: 250 });
  expect(pointsFallback([current], "api", all)).toBeNull();
  expect(pointsFallback([unseen], "pp", all)).toBeNull();
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(api, "billingCycles").mockResolvedValue({ accounts });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionMonth vendor="all" account="all" all={{ cards: [], select: () => {} }} />));
    await flushUntil(() => dom.host.textContent.includes("Subscription capacity vs usage"));
    const row = findByAttribute(dom.host, "data-subscription-row", "codex|codex2")!;
    const cells = findAll(row, (node) => node.tagName === "TD").map((node) => node.textContent);
    // Capacity, used, used %, unused in points; the return in API $ is unknown, the potential is not.
    expect(cells.slice(3, 9)).toEqual(["4 windows", "200 pp", "50%", "2 windows", "—", "20×"]);
    expect(findAll(row, (node) => node.tagName === "TD")[3]!.getAttribute("title")).toContain("In window points");
    // The unit's sum holds codex1 only, with the note.
    const text = summaryText(dom.host);
    expect(text).toContain("$4,000");
    expect(text).toContain("1 cycle without stored usage in this unit not included");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});
