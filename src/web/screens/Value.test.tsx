import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { shareFixture } from "../../shared/comparison-code.fixture";
import type { ProjectPlanResponse } from "../../shared/project-plan";
import type { RateWindow, SubscriptionRateResponse } from "../../shared/subscription-rate";
import { CommandPalette } from "../components/CommandPalette";
import { PageTabs } from "../components/PageNavigation";
import { Sidebar } from "../components/Sidebar";
import { api } from "../lib/api";
import { comparisonList } from "../lib/comparison-list";
import { emptyModel } from "../lib/cycle";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdowns, findByAttribute, findByText, flushUntil, installTestDom, invoke } from "../lib/test-dom-harness";
import { Value, type ValueView } from "./Value";
import { ProjectPlanPanel } from "./ProjectPlanPanel";
import { NAVIGATION, sectionScreen, type ScreenProps } from "../lib/screens";

const first = { ...shareFixture, account: "claude-a", plan: "Max", id: "a-week" };
const second = { ...first, account: "claude-b", id: "b-week", rate: 14.5 };
const rates = (windows: RateWindow[]): SubscriptionRateResponse => ({ windows, annotations: [], preparing: false, hours_preparing: false, stale: false });
const billing = (provider: string, account: string) => ({ provider, account, counter: "weekly", stale: false, cycles: [] });
const projectData: ProjectPlanResponse = { projects: ["p:atlas"], plans: [{ provider: "claude", id: "claude-max-20x", label: "Max 20×" }],
  preparing: false, stale: false, rows: ["historical", "today"].map((mode, i) => ({ provider: "claude", plan_id: "claude-max-20x", label: "Max 20×", mode: mode as "historical" | "today",
    api_usd: i ? 200 : 100, weeks: 1, months: 0.23, pro_rata: 46, whole_months: 200, sessions: 2, five_hour_limited: false,
    estimate: false, preliminary: false, reference_date: "2026-10-17", capacity_usd: 1000, absent: null, session_absent: null })) };

// Value's views take the shell's subscription like every account-scoped screen (IA-2026-10-19 v1.1, OP).
function valueView(view: ValueView, account: string, vendor: string) {
  const props = { account, accounts: [{ id: account, vendor }], card: null, sync: null, selectAccount() {} } as unknown as ScreenProps;
  return <Value {...props} view={view} cards={[]} />;
}

function installMonthDom() {
  const dom = installTestDom(), descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  return { host: dom.host, restore() {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    dom.restore();
  } };
}

test("navigation lists the six main entries and the palette finds former names without offering them", () => {
  setLanguage("en");
  const noop = () => {};
  const sidebar = renderToStaticMarkup(<Sidebar screen="capacity" goto={noop} collapsed={false} onToggleCollapse={noop}
    status={{ lastSync: null, calls: null, live: false }} />);
  const palette = renderToStaticMarkup(<CommandPalette model={emptyModel("claude-a", 10080)} onClose={noop} goto={noop} selectCycle={noop} setUnit={noop} toggleTheme={noop} />);
  for (const entry of ["Overview", "Limits", "Value", "Usage", "Projects", "Models", "Data and sync", "Settings"]) expect(sidebar).toContain(`aria-label="${entry}"`);
  expect(sidebar).toContain('aria-label="Limits" aria-current="page"');
  expect(sidebar).not.toContain("Subscription rate");
  expect(palette).toContain("Limits › Capacity");
  expect(palette).not.toContain("Subscription capacity");
  expect(palette).not.toContain("Subscription rate");
  expect(palette).not.toContain("Value per $1");
  const tabs = renderToStaticMarkup(<PageTabs screen="periods" open={noop} />);
  expect(tabs).toContain("Billing periods");
  expect(tabs).toContain("Plan comparison");
  expect(tabs).not.toContain("Value per $1");
});

test("billing periods load alone; the plan simulation loads independently of rates", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const cycles = spyOn(api, "billingCyclesOf").mockResolvedValue(billing("claude", "claude-a"));
  const rate = spyOn(api, "subscriptionRate").mockImplementation(() => new Promise(() => {}));
  const project = spyOn(api, "projectPlan").mockResolvedValue(projectData);
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("periods", "claude-a", "claude")));
    expect(cycles).toHaveBeenCalledTimes(1);
    expect(rate).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    await act(async () => root.render(<ProjectPlanPanel />));
    await flushUntil(() => dom.host.textContent.includes("Project on a chosen plan"));
    await chooseOption(dropdowns(dom.host)[0]!, "p:atlas");
    expect(project.mock.calls.at(-1)?.[0]).toBe("p:atlas");
    const checkbox = findByText(dom.host, "INPUT", "")!;
    await invoke(checkbox, "onChange", { target: { checked: true } });
    expect(project.mock.calls.at(-1)?.[1]).toEqual(["claude-max-20x"]);
    await chooseOption(dropdowns(dom.host)[1]!, "today");
    expect(dom.host.textContent).toContain("200 USD");
    expect(dom.host.textContent).not.toContain("100 USD");
    expect(rate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); cycles.mockRestore(); rate.mockRestore(); project.mockRestore(); dom.restore(); }
});

test("saved comparisons follow the selected account and All without showing another account while loading", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const cycles = spyOn(api, "billingCyclesOf").mockResolvedValue(billing("claude", "claude-a"));
  let publish!: (value: SubscriptionRateResponse) => void;
  const rate = spyOn(api, "subscriptionRate").mockImplementation(account => account === "claude-b"
    ? new Promise(resolve => { publish = resolve; }) : Promise.resolve(rates(account ? [first] : [first, second])));
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("shares", "claude-a", "claude")));
    await flushUntil(() => dom.host.textContent.includes("claude-a"));
    expect(rate.mock.calls.at(-1)?.[0]).toBe("claude-a");
    expect(findByAttribute(dom.host, "aria-label", "Subscription rate over time")).toBeNull();
    await act(async () => root.render(valueView("shares", "claude-b", "claude")));
    expect(dom.host.textContent).not.toContain("claude-a");
    await act(async () => publish(rates([second])));
    await flushUntil(() => dom.host.textContent.includes("claude-b"));
    expect(dom.host.textContent).not.toContain("claude-a");
    await act(async () => root.render(valueView("shares", "all", "all")));
    await flushUntil(() => dom.host.textContent.includes("claude-b"));
    expect(rate.mock.calls.at(-1)?.[0]).toBeUndefined();
    await chooseOption(dropdowns(dom.host)[0]!, first.id);
    await flushUntil(() => dom.host.textContent.includes("claude-a"));
  } finally { await act(async () => root.unmount()); cycles.mockRestore(); rate.mockRestore(); dom.restore(); }
});

test("sharing still generates a comparison code and retains local add/remove comparisons", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const cycles = spyOn(api, "billingCyclesOf").mockResolvedValue(billing("claude", "claude-a"));
  const rate = spyOn(api, "subscriptionRate").mockResolvedValue(rates([first]));
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("shares", "claude-a", "claude")));
    await flushUntil(() => findByText(dom.host, "BUTTON", "Copy code")?.getAttribute("disabled") === null);
    expect(findByText(dom.host, "BUTTON", "Copy PNG")!.getAttribute("disabled")).toBeNull();
    expect(findByText(dom.host, "BUTTON", "Save PNG")!.getAttribute("disabled")).toBeNull();
    await invoke(findByText(dom.host, "BUTTON", "Copy code")!, "onClick");
    expect(copied[0]).toStartWith("TA1-");
    await invoke(findByText(dom.host, "TEXTAREA", "")!, "onChange", { target: { value: copied[0] } });
    await invoke(findByText(dom.host, "BUTTON", "Add local comparison")!, "onClick");
    await flushUntil(() => findByText(dom.host, "BUTTON", "Remove comparison") !== null);
    expect(await comparisonList(localStorage).read()).toHaveLength(1);
    await invoke(findByText(dom.host, "BUTTON", "Remove comparison")!, "onClick");
    await flushUntil(() => findByText(dom.host, "BUTTON", "Remove comparison") === null);
    expect(await comparisonList(localStorage).read()).toHaveLength(0);
  } finally { await act(async () => root.unmount()); cycles.mockRestore(); rate.mockRestore(); dom.restore(); }
});

test("unsupported providers keep value tools and local comparisons without requesting rates", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const cycles = spyOn(api, "billingCyclesOf").mockResolvedValue(billing("gemini", "gemini-a"));
  const rate = spyOn(api, "subscriptionRate").mockImplementation(() => new Promise(() => {}));
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("shares", "gemini-a", "gemini")));
    await flushUntil(() => findByText(dom.host, "BUTTON", "Add local comparison") !== null);
    expect(findByText(dom.host, "BUTTON", "Copy code")!.getAttribute("disabled")).not.toBeNull();
    expect(rate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); cycles.mockRestore(); rate.mockRestore(); dom.restore(); }
});

test("a Codex Business account keeps the independent value tools and the plan simulation", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const cycles = spyOn(api, "billingCyclesOf").mockImplementation(() => new Promise(() => {}));
  const rate = spyOn(api, "subscriptionRate").mockImplementation(() => new Promise(() => {}));
  const project = spyOn(api, "projectPlan").mockResolvedValue(projectData);
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("periods", "codex1::business", "codex")));
    expect(dom.host.textContent).toContain("Business uses credits");
    await act(async () => root.render(<ProjectPlanPanel />));
    await flushUntil(() => dom.host.textContent.includes("Project on a chosen plan"));
    await act(async () => root.render(valueView("shares", "codex1::business", "codex")));
    await flushUntil(() => findByText(dom.host, "BUTTON", "Add local comparison") !== null);
    expect(rate).not.toHaveBeenCalled();
    expect(cycles).not.toHaveBeenCalled();
    expect(project).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); cycles.mockRestore(); rate.mockRestore(); project.mockRestore(); dom.restore(); }
});

/* ---- Value → Summary (UR-014 REQ-061) ---- */

const stats = (median: number | null, n: number, lower = false) => ({ n, median, min: median, max: median, lower_bound: lower });
const month = (key: string, usd: number, n: number, lower = false, plans = ["pro"]) =>
  ({ month: key, api_standard: stats(usd, n, lower), tokens: stats(usd * 4e6, n), plans, cycles: [] });
const summary = (months: ReturnType<typeof month>[], partial: number | null = null) => ({ months, models: [], closed: 9, eligible: 9, excluded: {},
  dominance_excluded: {}, notes: { uncertain_end: 0, manual: 0 },
  partial: partial === null ? null : { id: "now", cycle_start: "2026-10-29T10:00:00Z", observed_pp: 17, api_standard: partial, tokens: partial * 4e6, lower_bound: false } });
const candidates = { read_at: "2026-10-30T12:00:00Z", candidates: [
  { provider: "codex", account: "codex1", counter: "weekly", counter_label: "Weekly", state: "current", plan: "pro", plan_label: "Pro", usd_per_month: 200, recent_cycles: 5 },
  { provider: "claude", account: "claude1", counter: "weekly_all", counter_label: "Weekly", state: "current", plan: "max", plan_label: "Max 20×", usd_per_month: 200, recent_cycles: 4 },
] };
type SummaryBody = Awaited<ReturnType<typeof api.allowanceSummary>>;
const twoSides = (claude: Partial<SummaryBody["sides"][number]> = {}): SummaryBody => ({ since: "2026-08-01", until: "2026-10-30", unit: "api_standard", read_at: "2026-10-30T12:00:00Z",
  sides: [
    { provider: "codex", account: "codex1", counter: "weekly", counter_label: "Weekly", state: "current", summary: summary([month("2026-09", 1432, 6), month("2026-10", 1114, 11, true)], 1253) },
    { provider: "claude", account: "claude1", counter: "weekly_all", counter_label: "Weekly", state: "current", summary: summary([month("2026-09", 2245, 1, false, ["max", "pro"]), month("2026-10", 2648, 4, true)]), ...claude },
  ],
  ratios: [{ month: "2026-09", ratio: 2245 / 1432, min_n: 1, relation: null, approximate: false, a: 1432, b: 2245 },
    { month: "2026-10", ratio: 2648 / 1114, min_n: 4, relation: null, approximate: true, a: 1114, b: 2648 }],
  headline: { month: "2026-10", ratio: 2648 / 1114, min_n: 4, relation: null, approximate: true, a: 1114, b: 2648 } });

test("Value opens on the Summary, ahead of billing periods and plan comparison", () => {
  setLanguage("en");
  const value = NAVIGATION.find(section => section.id === "value")!;
  expect(sectionScreen(value)).toBe("value-summary");
  expect(value.tabs.map(tab => tab.views.map(view => view.screen))).toEqual([["value-summary"], ["periods"], ["plans", "shares"]]);
  const tabs = renderToStaticMarkup(<PageTabs screen="value-summary" open={() => {}} />);
  expect(tabs.indexOf("Summary")).toBeLessThan(tabs.indexOf("Billing periods"));
});

test("the summary compares two plans by month on one scale, keeps the open cycle apart and marks estimates", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const listed = spyOn(api, "allowanceCandidates").mockResolvedValue(candidates as never);
  const read = spyOn(api, "allowanceSummary").mockResolvedValue(twoSides());
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("value-summary", "codex1", "codex")));
    await flushUntil(() => dom.host.textContent.includes("What one allowance buys"));
    // Defaults: the dearest active plan and another provider's at the same price.
    expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ a: "codex1", b: "claude1", unit: "api_standard" });
    const text = dom.host.textContent;
    expect(text).toContain("Weekly limit · reset to reset");
    expect(text).toContain("≈ 2.38×");
    expect(text).toContain("≥ $1,114");
    expect(text).toContain("~$1,253");
    expect(text).toContain("first 17%");
    expect(text).toContain("1 cycle");
    expect(text).toContain("plan changed");
    // One chart holds both sides on its single axis.
    expect(findByAttribute(dom.host, "aria-label", "What one allowance buys by month")).not.toBeNull();
  } finally { await act(async () => root.unmount()); listed.mockRestore(); read.mockRestore(); dom.restore(); }
});

test("a preparing side is named as missing while the other stays, and an update keeps the last cycles", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const listed = spyOn(api, "allowanceCandidates").mockResolvedValue(candidates as never);
  const body = twoSides({ state: "preparing", summary: null });
  const read = spyOn(api, "allowanceSummary").mockResolvedValue({ ...body, sides: [{ ...body.sides[0]!, state: "updating" }, body.sides[1]!], ratios: [], headline: null });
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("value-summary", "codex1", "codex")));
    await flushUntil(() => dom.host.textContent.includes("What one allowance buys"));
    const text = dom.host.textContent;
    expect(text).toContain("preparing");
    expect(text).toContain("≥ $1,114");
    expect(text).toContain("Updating: the last published cycles are shown.");
    expect(text).not.toContain("Claude Max 20× ÷ Codex Pro");
  } finally { await act(async () => root.unmount()); listed.mockRestore(); read.mockRestore(); dom.restore(); }
});

test("without a weekly-limit subscription the summary says so instead of drawing an empty chart", async () => {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const listed = spyOn(api, "allowanceCandidates").mockResolvedValue({ read_at: "2026-10-30T12:00:00Z", candidates: [] });
  const read = spyOn(api, "allowanceSummary");
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("value-summary", "codex1", "codex")));
    await flushUntil(() => dom.host.textContent.includes("No subscription with a weekly limit"));
    expect(read).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); listed.mockRestore(); read.mockRestore(); dom.restore(); }
});

/* ---- Value → Summary, tokens by model (UR-014 REQ-062) ---- */

const group = (model: string, n: number, tokens: number, usd: number | null, perM: number | null, lower = false) => ({ model, n, cycles: [],
  api_standard: { ...stats(usd, n, lower) }, tokens: stats(tokens, n), usd_per_million: perM, lower_bound: lower, thin: n < 2 });
function withModels(codex: ReturnType<typeof group>[], claude: ReturnType<typeof group>[], excluded: Record<string, number> = {}): SummaryBody {
  const body = twoSides();
  return { ...body, sides: [{ ...body.sides[0]!, summary: { ...body.sides[0]!.summary!, models: codex, dominance_excluded: excluded } },
    { ...body.sides[1]!, summary: { ...body.sides[1]!.summary!, models: claude } }] };
}
async function renderModels(body: SummaryBody, check: (text: string) => void) {
  const dom = installMonthDom(), root = createRoot(dom.host as unknown as Element);
  const listed = spyOn(api, "allowanceCandidates").mockResolvedValue(candidates as never);
  const read = spyOn(api, "allowanceSummary").mockResolvedValue(body);
  setLanguage("en");
  try {
    await act(async () => root.render(valueView("value-summary", "codex1", "codex")));
    await flushUntil(() => dom.host.textContent.includes("One allowance in tokens"));
    check(dom.host.textContent);
  } finally { await act(async () => root.unmount()); listed.mockRestore(); read.mockRestore(); dom.restore(); }
}

test("the model card shows tokens and dollars per allowance by dominant model, bounds and gaps included", async () => {
  await renderModels(withModels([group("gpt-6.1-sol", 5, 6.32e9, 1085, 0.192, true), group("gpt-6-astra", 9, 1.65e9, 1298, 0.813, true), group("gpt-5.4", 1, 2e7, 13, 0.5)],
    [group("claude-opus-5-5", 6, 6.57e9, null, null)], { below_threshold: 3 }), text => {
    expect(text).toContain("mostly gpt-6.1-sol · 5 cycles");
    expect(text).toContain("6.32B");
    expect(text).toContain("≥ $1,085 · $0.192");
    expect(text).toContain("mostly claude-opus-5-5 · 6 cycles");
    expect(text).toContain("no price");
    expect(text).not.toContain("$0 ·");
    // A single-cycle group is left out of the rows and counted in the card's help instead.
    expect(text).not.toContain("mostly gpt-5.4");
    expect(text).toContain("1 groups with one cycle left out");
    expect(text).toContain("3 weeks without one model at 70%");
  });
});

test("the model card says why it is empty instead of drawing nothing", async () => {
  await renderModels(withModels([group("gpt-5.4", 1, 2e7, 13, 0.5)], []), text => expect(text).toContain("Only single-cycle groups"));
  await renderModels(withModels([], []), text => expect(text).toContain("No week with one model at 70% of its value"));
});
