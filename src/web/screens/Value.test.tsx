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
import type { ScreenProps } from "../lib/screens";

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
