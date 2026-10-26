import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type CycleSettingRow, type PlanSettingRow, type PlansCatalog } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdownOptions, dropdowns, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { RailAccount } from "./AccountPeriodGroups";
import { accountSectionTabs, AllAccountsSettings, accountSubscriptions, type AccountSection } from "./AccountSettingsSections";
import type { DataSettingsTarget } from "../lib/data-settings";

const catalog: PlansCatalog = { provider_groups: [
  { id: "openai", label: "OpenAI", aliases: ["codex", "openai"], plans: [
    { plan_id: "codex-pro", label: "Pro", versions: [{ from: "2025-01-01", usd_per_month: 200, limits: { weekly_cap: true } }] },
    { plan_id: "codex-plus", label: "Plus", versions: [{ from: "2025-01-01", usd_per_month: 20, limits: { weekly_cap: true } }] },
  ] },
  { id: "xai", label: "xAI", aliases: ["grok", "xai"], plans: [] },
] };
const sub = (subscription: string, plan: string | null, vendor = "codex"): PlanSettingRow => ({
  subscription, vendor, fallback_usd_per_month: null, capacity_regimes: [],
  plan_on_day: plan ? { plan, plan_id: `codex-${plan}`, basis: "declared", from: "2026-01-01", until: null }
    : { plan: null, plan_id: null, basis: "none", from: null, until: null },
});
const subscriptions = [sub("codex1", "pro"), sub("codex1::business", null), sub("codex2", "plus"), sub("grok", null, "grok")];
const social: RailAccount = { provider: "codex", account: "codex1", aliases: ["chatgpt-aa", "codex1"], label: "socialmedia@example.pl" };
const cycle = (subscription: string, vendor: string, kind: string): CycleSettingRow => ({
  subscription, vendor, kind, label: kind, period_hours: 168, period_source: "declared", anchor_ts: null, anchor_source: "none",
  history_windows: 40, history_source: "default", window_start: null, next_reset: null, history_available: 0,
  editable: { period: true, anchor: true, history: true }, declaration_editable: true, effect: "", declared: true, note: null,
  segments: [{ from: null, period_hours: 168, period_source: "declared", anchor_ts: null, anchor_source: "none", history_windows: 40, note: null, source: "declared", declaration: true }],
} as CycleSettingRow);
const cycles = [cycle("codex1", "codex", "secondary"), cycle("codex2", "codex", "secondary"), cycle("claude", "?", "weekly_all"), cycle("grok", "grok", "rolling")];

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const attr = (host: TestNode, name: string) => nodes(host).filter((node) => node.getAttribute(name) != null).map((node) => node.getAttribute(name));

let root: Root | null = null;
let restore = () => {};
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  while (spies.length) spies.pop()!.mockRestore();
  restore();
  setLanguage("en");
});
function mockApi() {
  const reads = {
    catalog: spyOn(api, "plansCatalog").mockResolvedValue({ path: "fixture", catalog }),
    capacity: spyOn(api, "planCapacity").mockResolvedValue(null as never),
    cycles: spyOn(api, "cycles").mockResolvedValue({ path: "fixture", default_history_windows: 40, min_history_period_hours: 24, rows: cycles }),
    grok: spyOn(api, "grokAnchor").mockImplementation(() => new Promise(() => {})),
  };
  spies.push(...Object.values(reads));
  return reads;
}
async function mount(element: React.ReactElement) {
  const dom = installTestDom();
  restore = dom.restore;
  root = createRoot(dom.host as unknown as Element);
  await act(async () => root!.render(element));
  return dom.host;
}
const spec = (account = social, target?: DataSettingsTarget) =>
  accountSectionTabs({ account, subscriptions, asOf: "2026-10-08", onAsOf: () => {}, target, t: (en) => en });
/** The given tabs rendered under their labels, as the switcher under the timeline shows the open one. */
const sections = (open: AccountSection[], account = social, target?: DataSettingsTarget) => {
  const { tabs, note } = spec(account, target);
  return <>{note}{tabs.filter((tab) => open.includes(tab.key as AccountSection)).map((tab) => <section key={tab.key}><h4>{tab.label}</h4>{tab.render()}</section>)}</>;
};

describe("Settings → Accounts sections", () => {
  test("an account holds its own subscriptions and their billing variants", () => {
    expect(accountSubscriptions(social, subscriptions).map((row) => row.subscription)).toEqual(["codex1", "codex1::business"]);
  });

  test("tabs not shown read nothing; an account without a subscription entry says so in one line", async () => {
    const reads = mockApi();
    expect(spec().tabs.map((tab) => tab.key)).toEqual(["price", "promotions", "rhythm", "windows"]);
    const host = await mount(sections([]));
    expect(host.textContent).toBe("");
    expect(reads.catalog).not.toHaveBeenCalled();
    expect(reads.cycles).not.toHaveBeenCalled();
    await act(async () => root!.render(sections(["price"], { provider: "gemini", account: "g1", aliases: ["g1"], label: "x@example.com" })));
    expect(host.textContent).toBe("No subscription entry — price, promotions and window rhythm do not apply to this account.");
  });

  test("price and calibration lists only this account's rows and asks capacity only for their plans", async () => {
    const reads = mockApi();
    const host = await mount(sections(["price"], social, { area: "subscriptions", account: "codex1::business" }));
    await flushUntil(() => attr(host, "data-subscription-id").length > 0);
    expect(attr(host, "data-subscription-id")).toEqual(["codex1", "codex1::business"]);
    expect(nodes(host).find((node) => node.getAttribute("data-subscription-id") === "codex1::business")?.getAttribute("data-selected")).toBe("1");
    expect(reads.capacity.mock.calls.map((call) => call[0])).toEqual([{ provider: "openai", plan_id: "codex-pro", window_kind: "weekly", as_of: "2026-10-08" }]);
    expect(reads.cycles).not.toHaveBeenCalled();
  });

  test("promotions edit this account's subscriptions and window rhythm shows its rows, with the Grok anchor only on Grok", async () => {
    mockApi();
    const host = await mount(sections(["promotions", "rhythm"], social, { area: "cadence", account: "codex1" }));
    await flushUntil(() => attr(host, "data-rhythm-row").length > 0);
    expect(host.textContent).toContain("Promotions and capacity");
    const subscriptionPicker = dropdowns(nodes(host).find((node) => node.className === "capacity-promotion-account")!)[0]!;
    expect((await dropdownOptions(subscriptionPicker)).map((option) => option.label).filter((label) => label.startsWith("codex1")))
      .toEqual(["codex1 · codex", "codex1::business · codex"]);
    await invoke(subscriptionPicker, "onClick");
    expect(attr(host, "data-rhythm-row")).toEqual(["codex1/secondary"]);
    // A cadence link opens the history of its subscription's rows, as the Window rhythms tab did.
    expect(attr(host, "data-rhythm-expanded")).toEqual(["codex1/secondary"]);
    expect(host.textContent).not.toContain("Grok");
    await act(async () => root!.render(sections(["rhythm"], { provider: "grok", account: "grok", aliases: ["grok"], label: "grok" })));
    await flushUntil(() => attr(host, "data-rhythm-row").includes("grok/rolling"));
    expect(attr(host, "data-rhythm-row")).toEqual(["grok/rolling"]);
  });

  test("a tab does not repeat its label inside: only the sub-lines that carry information stay", async () => {
    mockApi();
    const host = await mount(sections(["price", "promotions", "rhythm"]));
    await flushUntil(() => attr(host, "data-rhythm-row").length > 0 && attr(host, "data-subscription-id").length > 0);
    const count = (text: string) => host.textContent.split(text).length - 1;
    expect(count("Price and calibration")).toBe(1);
    expect(count("Promotions and capacity")).toBe(1);
    expect(host.textContent).toContain("as of 2026-10-08");
    // The price and rhythm tabs carry the "As of" day they are read for.
    expect(attr(host, "aria-label").filter((label) => label === "As of date")).toHaveLength(2);
    expect(host.textContent).toContain("Account-specific periods. Only confirmed, enabled terms affect estimates.");
    // The rhythm tab's provider group heading only repeated the account's provider.
    expect(nodes(host).some((node) => node.className === "ui-card-title-text" && node.textContent === "OpenAI")).toBe(false);
    expect(attr(host, "data-subscription").length).toBeGreaterThan(0);
  });

  test("All accounts adds every subscription's price and, folded, the rhythms no listed account holds", async () => {
    const reads = mockApi();
    const host = await mount(<AllAccountsSettings accounts={[social, { provider: "codex", account: "codex2", aliases: ["codex2"], label: "k@example.pl" },
      { provider: "grok", account: "grok", aliases: ["grok"], label: "grok" }]} subscriptions={subscriptions} asOf="2026-10-08" onAsOf={() => {}} provider="all" />);
    await flushUntil(() => attr(host, "data-subscription-id").length === 4);
    expect(attr(host, "data-subscription-id")).toEqual(["codex1", "codex1::business", "codex2", "grok"]);
    // Outside an account's fold the cross-account table keeps its title.
    expect(host.textContent).toContain("Price and calibration");
    expect(reads.cycles).not.toHaveBeenCalled();
    const fold = nodes(host).find((node) => node.getAttribute("data-account-section") === "orphan-rhythms")!;
    expect(fold.textContent).toBe("Window rhythms without a listed account");
    const props = (fold as unknown as Record<string, { onToggle: (event: unknown) => void }>)[Object.keys(fold).find((key) => key.startsWith("__reactProps$"))!]!;
    await act(async () => props.onToggle({ currentTarget: { open: true } }));
    await flushUntil(() => attr(host, "data-rhythm-row").length > 0);
    expect(attr(host, "data-rhythm-row")).toEqual(["claude/weekly_all"]);
  });
});


test("Windows opens the linked cycle, saves an early end and resets its scope when the account changes", async () => {
  const cycle = { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" };
  const window = { account: "codex1", counter: "weekly", window_start: cycle.start, window_end: "2026-09-04T00:00:00.000Z",
    planned_reset: "2026-09-08T00:00:00.000Z", cause: "unknown" as const, auto: "unknown" as const, override: null };
  const read = spyOn(api, "windowEndOverrides").mockResolvedValue({ revision: "one", windows: [window], pending: false });
  const save = spyOn(api, "saveWindowEndOverride").mockResolvedValue({ revision: "two", windows: [{ ...window, cause: "provider", override: "provider" }], pending: false });
  spies.push(read, save);
  const host = await mount(sections(["windows"], social, { area: "windows", account: "codex1", cycle }));
  await flushUntil(() => attr(host, "data-window-end").length > 0);
  expect(read.mock.calls[0]!.slice(0, 2)).toEqual(["codex", ["codex1", "chatgpt-aa"]]);
  expect(host.textContent).toContain("This cycle · 1");
  await chooseOption(dropdowns(host)[0]!, "provider");
  await flushUntil(() => save.mock.calls.length > 0);
  expect(save.mock.calls[0]).toEqual(["codex", ["codex1", "chatgpt-aa"], {
    revision: "one", account: "codex1", counter: "weekly", window_start: cycle.start, cause: "provider",
  }]);
  read.mockResolvedValue({ revision: "other", windows: [], pending: false });
  await act(async () => root!.render(sections(["windows"], { provider: "codex", account: "codex2", aliases: ["codex2"], label: "other" })));
  await flushUntil(() => host.textContent.includes("No windows"));
  expect(attr(host, "data-window-end")).toEqual([]);
  expect(host.textContent).not.toContain("This cycle");
});
