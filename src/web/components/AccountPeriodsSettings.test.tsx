import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { AccountPeriodRow, AccountPeriodsView, PeriodEditPreview, PlanPeriodRow } from "../../shared/account-periods";
import type { PlanPriceCoverage, PlanPriceCoverageSubject } from "../../shared/plan-price-coverage";
import type { BillingCycle, BillingCyclesView } from "../../shared/billing-cycles";
import { ApiError, api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdownOptions, dropdowns, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { AccountPeriodsSettings, type AccountCardExtras } from "./AccountPeriodsSettings";
import { holdsSubscription, type RailAccount } from "./AccountPeriodGroups";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
function button(root: TestNode, text: string): TestNode {
  const node = nodes(root).find((candidate) => candidate.tagName === "BUTTON" && candidate.textContent === text);
  if (!node) throw new Error(`Button not found: ${text}`);
  return node;
}
function labelled(root: TestNode, text: string): TestNode {
  const label = nodes(root).find((node) => node.tagName === "LABEL" && node.textContent.startsWith(text));
  if (!label) throw new Error(`Label not found: ${text}`);
  const control = nodes(label).find((node) => node.tagName === "INPUT" || node.getAttribute("aria-haspopup") === "listbox");
  if (!control) throw new Error(`Control not found: ${text}`);
  return control;
}

const observed = (row: Partial<AccountPeriodRow> & { id: number; source: string; account: string; from: string }): AccountPeriodRow => ({
  provider: "claude", until: null, origin: "observed", firstSeen: row.from, lastSeen: row.from, readings: 12,
  evidence: "profile-reading", note: null, ...row,
});
const declared = (row: Partial<AccountPeriodRow> & { id: number; source: string; account: string; from: string }): AccountPeriodRow => ({
  provider: "claude", until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0,
  evidence: "owner-declaration", note: null, ...row,
});
const plan = (row: Partial<PlanPeriodRow> & { id: number; account: string; plan: string; from: string }): PlanPeriodRow => ({
  provider: "claude", until: null, origin: "observed", firstSeen: null, lastSeen: null, readings: 3,
  evidence: "profile-reading", note: null, amountMinor: null, currency: null, ...row,
});

function fixture(overrides: Partial<AccountPeriodsView> = {}): AccountPeriodsView {
  return {
    revision: "rev-1",
    sources: [
      { provider: "claude", key: "claude/pc-a", machine: "PC-A", profile: ".claude", events: { first: "2026-01-10", last: "2026-09-20", calls: 4000 } },
      { provider: "claude", key: "claude/pc-b", machine: "PC-B", profile: ".claude-2", events: { first: "2026-08-01", last: "2026-08-20", calls: 900 } },
      { provider: "codex", key: "codex/pc-c", machine: "PC-C", profile: ".codex", events: { first: "2026-09-01", last: "2026-09-20", calls: 700 } },
    ],
    accounts: [
      { provider: "claude", id: "claude-1", label: "account_0006@example.test", current: true },
      { provider: "claude", id: "claude-2", label: "account_0002@example.test", current: false },
      { provider: "codex", id: "codex1", label: "account_0004@example.test", current: false },
    ],
    accountPeriods: [
      // Two observed rows of one source with a silence between them, both after the first recorded event.
      observed({ id: 1, source: "claude/pc-a", account: "claude-2", from: "2026-03-01T00:00:00Z", until: "2026-03-10T00:00:00Z" }),
      observed({ id: 2, source: "claude/pc-a", account: "claude-1", from: "2026-09-09T15:48:00Z", until: null, readings: 340 }),
      // A declared row covering an observed one, and closing before the last recorded event.
      declared({ id: 3, source: "claude/pc-b", account: "claude-2", from: "2026-08-01", until: "2026-08-15", note: "z wyciągu karty" }),
      observed({ id: 4, source: "claude/pc-b", account: "claude-1", from: "2026-08-05T10:00:00Z", until: "2026-08-06T10:00:00Z" }),
      observed({ id: 5, provider: "codex", source: "codex/pc-c", account: "codex1", from: "2026-09-01T08:00:00Z", until: null }),
    ],
    planPeriods: [
      plan({ id: 10, account: "claude-1", plan: "default_claude_max_5x", from: "2026-09-12T19:41:00Z" }),
      plan({ id: 11, account: "claude-2", plan: "max-20x", from: "2026-02-28", until: "2026-03-28", origin: "declared",
        evidence: "payment-receipt", amountMinor: 10181, currency: "EUR", readings: 0, tier: { label: "Max 20x", multiplier: 20 } }),
    ],
    declarations: { file: "${ARCHIVE}/config/account-periods.json", present: true, errors: [] },
    ...overrides,
  };
}

const emptyPreview = (overrides: Partial<PeriodEditPreview> = {}): PeriodEditPreview =>
  ({ events: { calls: 900, days: 14, first: "2026-08-01", last: "2026-08-14" }, overrides: [], errors: [], ...overrides });

async function render(view: AccountPeriodsView = fixture(), provider = "all", aliases: string[] = [],
  coverage: PlanPriceCoverage = { since: null, until: null, subjects: [] }, extras?: AccountCardExtras, cycles: BillingCyclesView = { accounts: [] }) {
  setLanguage("pl");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const load = spyOn(api, "accountPeriods").mockResolvedValue(view);
  const priced = spyOn(api, "planPriceCoverage").mockResolvedValue(coverage);
  const billed = spyOn(api, "billingCycles").mockResolvedValue(cycles);
  await act(async () => { root.render(<AccountPeriodsSettings provider={provider} providerAliases={aliases} extras={extras} />); });
  await flushUntil(() => dom.host.textContent.includes("Wszystkie konta — przegląd"));
  return { host: dom.host, root, load, priced, billed, restore: dom.restore };
}
async function cleanup(rendered: Awaited<ReturnType<typeof render>>, spies: Array<{ mockRestore: () => void }> = []) {
  for (const spy of spies) spy.mockRestore();
  rendered.load.mockRestore();
  rendered.priced.mockRestore();
  rendered.billed.mockRestore();
  await act(async () => rendered.root.unmount());
  rendered.restore();
  setLanguage("en"); // The language is process-wide; leaving it Polish would break every other suite.
}

const findButton = (host: TestNode, includes: string) => {
  const found = nodes(host).find((node) => node.tagName === "BUTTON" && node.textContent.includes(includes));
  if (!found) throw new Error("Missing button: " + includes);
  return found;
};
/** The edit button of a timeline period; the period itself is its drag surface. */
const bar = (host: TestNode, label: string) => {
  const found = nodes(host).find((node) => node.tagName === "BUTTON" && node.className.includes("account-history-edit") && node.attributes["aria-label"]?.startsWith(`Edytuj: ${label}`));
  if (!found) throw new Error("Missing timeline period: " + label);
  return found;
};
const dragSurface = (host: TestNode, label: string) => bar(host, label).parentNode!;
const formOf = (host: TestNode) => nodes(host).find((node) => node.tagName === "FORM")!;
/** One labelled fact of the account header, as text. */
const fact = (host: TestNode, key: string) => nodes(host).find((node) => node.attributes["data-fact"] === key)?.textContent;
async function selectAccount(host: TestNode, label: string) {
  await invoke(findButton(host, label), "onClick");
}
async function selectHistoricalPlan(host: TestNode) {
  await selectAccount(host, "account_0002@example.test");
  await invoke(button(host, "Cała historia"), "onClick");
  await invoke(bar(host, "Max · ×20,"), "onClick");
}

/** The fields and stamps follow this computer's clock; the suite pins it so stored UTC values read the same everywhere. */
function withTimeZone(zone: string) {
  let before: string | undefined;
  beforeAll(() => { before = process.env.TZ; process.env.TZ = zone; });
  afterAll(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
}

describe("AccountPeriodsSettings", () => {
  withTimeZone("UTC");

  describe("on a computer east of UTC", () => {
    withTimeZone("Europe/Warsaw");

    test("the date fields show and accept this computer's clock and store UTC; the UTC instant stays in the tooltip", async () => {
      const rendered = await render();
      const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
      try {
        await selectHistoricalPlan(rendered.host);
        const form = formOf(rendered.host);
        // A day-only start is that day's UTC midnight: 01:00 in Warsaw in winter.
        expect(labelled(form, "Od").value).toBe("2026-02-28T01:00");
        expect(labelled(form, "Od").getAttribute("title")).toBe("UTC 2026-02-28 00:00");
        expect(form.textContent).not.toContain("czasu lokalnego");
        await invoke(labelled(form, "Od"), "onChange", { target: { value: "2026-03-01T10:00" } });
        await invoke(button(formOf(rendered.host), "Podgląd"), "onClick");
        await flushUntil(() => preview.mock.calls.length > 0);
        expect(preview.mock.calls[0]?.[0]).toMatchObject({ row: { from: "2026-03-01T09:00:00.000Z" } });
      } finally { await cleanup(rendered, [preview]); }
    });
  });

  test("an overlap names the other period in words and offers to end before the next one", async () => {
    const view = fixture();
    view.planPeriods.push(plan({ id: 12, account: "claude-2", plan: "max-5x", from: "2026-04-10", origin: "declared", evidence: "owner", readings: 0 }));
    const rendered = await render(view);
    const raw = "nakładające się okresy: claude/claude-2 max-20x [2026-02-28T00:00:00.000Z, 2026-04-20T00:00:00.000Z) oraz claude/claude-2 max-5x [2026-04-10, …)";
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValueOnce(emptyPreview({ errors: [raw] })).mockResolvedValue(emptyPreview());
    try {
      await selectHistoricalPlan(rendered.host);
      await invoke(labelled(formOf(rendered.host), "Do"), "onChange", { target: { value: "2026-04-20T00:00" } });
      await invoke(button(formOf(rendered.host), "Podgląd"), "onClick");
      await flushUntil(() => formOf(rendered.host).textContent.includes("Te daty nakładają się na inny Twój okres:"));
      const form = formOf(rendered.host);
      expect(form.textContent).toContain("Max · ×5 · 2026-04-10 00:00 → trwa");
      expect(form.textContent).not.toContain("2026-02-28T00:00:00.000Z");
      await invoke(findButton(form, "Zakończ przed następnym okresem"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 1);
      expect(labelled(formOf(rendered.host), "Do").value).toBe("2026-04-10T00:00");
      expect(preview.mock.calls[1]?.[0]).toMatchObject({ row: { until: "2026-04-10T00:00:00.000Z" } });
      await flushUntil(() => !button(formOf(rendered.host), "Zapisz").hasAttribute("disabled"));
    } finally { await cleanup(rendered, [preview]); }
  });

  test("a subscription belongs to the account holding its id; a billing variant to its base id, never by e-mail", () => {
    const social = { provider: "codex", aliases: ["codex1", "chatgpt-1"] };
    expect(holdsSubscription(social, "codex1", "codex")).toBe(true);
    expect(holdsSubscription(social, "codex1::business", "openai")).toBe(true);
    expect(holdsSubscription(social, "codex1", "claude")).toBe(false);
    expect(holdsSubscription(social, "codex3", "codex")).toBe(false);
    expect(holdsSubscription({ provider: "claude", aliases: ["claude-1"] }, "claude", "?")).toBe(false);
  });

  test("Settings selects a link's account, adds its sections under the one-account timeline and the list's under all accounts", async () => {
    const seen: RailAccount[] = [];
    let listed: RailAccount[] = [];
    const rendered = await render(fixture(), "all", [], undefined, {
      selectAccount: "claude-1",
      accountSections: (account) => { seen.push(account); return { tabs: [], note: <p>sections of {account.label}</p> }; },
      allAccountsSections: (accounts) => { listed = accounts; return <p>every account table</p>; },
    });
    try {
      // Without the link the rail would open account_0002@example.test, the first of two accounts with one plan each.
      expect(rendered.host.textContent).toContain("sections of account_0006@example.test");
      expect(seen.at(-1)).toMatchObject({ provider: "claude", aliases: ["claude-1"] });
      expect(rendered.host.textContent).not.toContain("every account table");
      await invoke(findButton(rendered.host, "Wszystkie konta — przegląd"), "onClick");
      expect(rendered.host.textContent).toContain("every account table");
      expect(rendered.host.textContent).not.toContain("sections of");
      expect(listed.map((account) => account.label).sort()).toEqual(["account_0002@example.test", "account_0004@example.test", "account_0006@example.test"]);
    } finally { await cleanup(rendered); }
  });

  test("one account joins aliases and both computer lanes; provider filters still apply", async () => {
    const data = fixture();
    data.accounts.push({ provider: "claude", id: "old-social", label: "ACCOUNT_0006@example.test", current: false });
    data.accountPeriods.push(observed({ id: 99, account: "old-social", source: "claude/pc-b", from: "2026-09-01" }));
    const rendered = await render(data, "anthropic", ["claude"]);
    try {
      const choices = nodes(rendered.host).filter((node) => node.className.startsWith("account-periods-account-choice") && !node.className.includes("all-choice"));
      expect(choices.filter((node) => node.textContent.toLowerCase().includes("account_0006@example.test"))).toHaveLength(1);
      await selectAccount(rendered.host, "account_0006@example.test");
      expect(rendered.host.textContent).toContain("PC-A");
      expect(rendered.host.textContent).toContain("PC-B");
      expect(rendered.host.textContent).not.toContain("PC-C");
      expect(rendered.host.textContent).not.toContain("account_0004@example.test");
    } finally { await cleanup(rendered); }
  });

  test("offers one-account and all-account timelines, with explicit missing history", async () => {
    const rendered = await render();
    try {
      expect(nodes(rendered.host).filter((node) => node.className === "account-history-chart")).toHaveLength(1);
      await invoke(findButton(rendered.host, "Wszystkie konta — przegląd"), "onClick");
      expect(nodes(rendered.host).filter((node) => node.className === "account-history-chart")).toHaveLength(3);
      expect(rendered.host.textContent).toContain("Historia do uzupełnienia");
      expect(rendered.host.textContent).toContain("Nieznane konto");
      expect(rendered.host.textContent).toContain("Niepewne konto");
      // The rail stays beside "All accounts"; choosing an entry returns to one history.
      await invoke(findButton(rendered.host, "Do uzupełnienia"), "onClick");
      expect(nodes(rendered.host).some((node) => node.id === "account-history-unassigned")).toBe(true);
    } finally { await cleanup(rendered); }
  });

  test("a plan click shows details; its editor contains plan and dates without redundant identity selectors", async () => {
    const rendered = await render();
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      await invoke(bar(rendered.host, "Max · ×5,"), "onClick");
      expect(nodes(rendered.host).filter((node) => node.tagName === "DIALOG")).toHaveLength(1);
      expect(nodes(rendered.host).some((node) => node.className === "account-history-selection")).toBe(false);
      expect(nodes(rendered.host).some((node) => node.tagName === "BUTTON" && node.textContent === "Popraw")).toBe(false);
      expect(rendered.host.textContent).toContain("2026-09-12 19:41");
      const form = formOf(rendered.host);
      expect(form.textContent).toContain("Plan i daty");
      expect(rendered.host.textContent).toContain("account_0006@example.test");
      // The plan and its billing period length; no account or provider selector.
      expect(dropdowns(form)).toHaveLength(2);
      expect(labelled(form, "Okres rozliczeniowy").getAttribute("aria-haspopup")).toBe("listbox");
      expect(labelled(form, "Plan").getAttribute("aria-haspopup")).toBe("listbox");
      expect(labelled(form, "Od").value).toBe("2026-09-12T19:41");
      expect(button(form, "Zapisz").hasAttribute("disabled")).toBe(true);
      await invoke(button(form, "Anuluj"), "onClick");
      expect(formOf(rendered.host)).toBeUndefined();
    } finally { await cleanup(rendered); }
  });

  test("clicking an unknown plan period opens a prefilled creation drawer and Escape dismisses it", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      const trigger = bar(rendered.host, "Plan nieustalony,");
      await invoke(trigger, "onClick");
      const form = formOf(rendered.host);
      expect(labelled(form, "Od").value).toBe("2026-09-09T15:48");
      expect(labelled(form, "Do").value).toBe("2026-09-12T19:41");
      await chooseOption(labelled(form, "Plan"), "pro");
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: null, row: { account: "claude-1", from: "2026-09-09T15:48:00.000Z", until: "2026-09-12T19:41:00.000Z", plan: "pro" } });
      const dialog = nodes(rendered.host).find((node) => node.tagName === "DIALOG")!;
      await invoke(dialog, "onCancel", { preventDefault() {} });
      expect(formOf(rendered.host)).toBeUndefined();
    } finally { await cleanup(rendered, [preview]); }
  });

  test("the plan editor offers \"Brak abonamentu\" for any provider and a declared one is named so on the timeline", async () => {
    const data = fixture();
    data.planPeriods.push(plan({ id: 12, provider: "codex", account: "codex1", plan: "none", from: "2026-08-01", until: "2026-09-01", origin: "declared", readings: 0 }));
    const rendered = await render(data);
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      await invoke(bar(rendered.host, "Plan nieustalony,"), "onClick");
      const form = formOf(rendered.host);
      const options = await dropdownOptions(labelled(form, "Plan"));
      expect(options.map((option) => [option.value, option.label]).at(-2)).toEqual(["none", "Brak abonamentu"]);
      await chooseOption(labelled(form, "Plan"), "none");
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: null, row: { account: "claude-1", plan: "none" } });
      await invoke(button(form, "Anuluj"), "onClick");
      // A Codex account: the same built-in value, never a catalog plan; its declared stretch reads as words.
      await selectAccount(rendered.host, "account_0004@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      expect(bar(rendered.host, "Brak abonamentu,")).toBeDefined();
      await invoke(bar(rendered.host, "Brak abonamentu,"), "onClick");
      const codexOptions = await dropdownOptions(labelled(formOf(rendered.host), "Plan"));
      expect(codexOptions.filter((option) => option.value === "none").map((option) => option.label)).toEqual(["Brak abonamentu"]);
    } finally { await cleanup(rendered, [preview]); }
  });

  test("merged plan records can be edited in the drawer without changing their stored identity", async () => {
    const data = fixture();
    data.accounts.push({ provider: "claude", id: "old-social", label: "account_0006@example.test", current: false });
    data.planPeriods.push(plan({ id: 99, account: "old-social", plan: "max-5x", from: "2026-09-12T19:41:00Z", origin: "declared" }));
    const rendered = await render(data);
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      await invoke(bar(rendered.host, "Max · ×5,"), "onClick");
      await chooseOption(labelled(rendered.host, "Zapis okresu do poprawienia"), "plan|99");
      expect(nodes(rendered.host).filter((node) => node.tagName === "DIALOG")).toHaveLength(1);
      expect(nodes(rendered.host).filter((node) => node.tagName === "FORM")).toHaveLength(1);
      await invoke(button(formOf(rendered.host), "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: { account: "old-social", from: "2026-09-12T19:41:00Z" }, row: { account: "old-social" } });
    } finally { await cleanup(rendered, [preview]); }
  });

  test("preview then save preserves a declared plan's original replace key", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview(), applied: false, view: fixture({ revision: "rev-2" }) });
    try {
      await selectHistoricalPlan(rendered.host);
      const form = formOf(rendered.host);
      await invoke(labelled(form, "Notatka"), "onChange", { target: { value: "potwierdzenie płatności" } });
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => !button(form, "Zapisz").hasAttribute("disabled"));
      await invoke(form, "onSubmit", { preventDefault() {} });
      await flushUntil(() => save.mock.calls.length > 0);
      expect(save.mock.calls[0]?.[0]).toMatchObject({ revision: "rev-1", kind: "plan", replace: { account: "claude-2", from: "2026-02-28" },
        row: { provider: "claude", account: "claude-2", plan: "max-20x", from: "2026-02-28T00:00:00.000Z", until: "2026-03-28T00:00:00.000Z", note: "potwierdzenie płatności", amount_minor: 10181 } });
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("declared source corrections keep original keys and evidence when opened from the chart", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await invoke(bar(rendered.host, "PC-B .claude-2,"), "onClick");
      await invoke(button(rendered.host, "▸ zaobserwowany oryginał (1)"), "onClick");
      expect(rendered.host.textContent).toContain("Zaobserwowany oryginał: account_0006@example.test");
      await invoke(button(formOf(rendered.host), "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "account", replace: { source: "claude/pc-b", from: "2026-08-01" },
        row: { source: "claude/pc-b", account: "claude-2", from: "2026-08-01T00:00:00.000Z", until: "2026-08-15T00:00:00.000Z" } });
    } finally { await cleanup(rendered, [preview]); }
  });

  test("assigning an unknown interval preserves its dates and does not replace another declaration", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await invoke(findButton(rendered.host, "Do uzupełnienia"), "onClick");
      const gap = findButton(rendered.host, "Niepewne konto");
      await invoke(gap, "onClick");
      const form = formOf(rendered.host);
      await chooseOption(labelled(form, "Konto"), "claude-1");
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "account", replace: null,
        row: { source: "claude/pc-a", account: "claude-1", from: "2026-03-10T00:00:00.000Z", until: "2026-09-09T15:48:00.000Z" } });
    } finally { await cleanup(rendered, [preview]); }
  });

  test("an archive with no identified accounts still allows adding plan history", async () => {
    const rendered = await render(fixture({ accounts: [], accountPeriods: [], planPeriods: [] }), "anthropic", ["claude"]);
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    try {
      await invoke(button(rendered.host, "+ Dodaj historię planu"), "onClick");
      const form = formOf(rendered.host);
      await invoke(labelled(form, "Identyfikator konta"), "onChange", { target: { value: "new-account" } });
      await chooseOption(labelled(form, "Plan"), "pro");
      await invoke(labelled(form, "Od"), "onChange", { target: { value: "2026-09-01T00:00" } });
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => preview.mock.calls.length > 0);
      expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: null, row: { provider: "claude", account: "new-account", plan: "pro" } });
    } finally { await cleanup(rendered, [preview]); }
  });

  test("remove targets the declaration and stale revisions retain the unsaved draft", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    const save = spyOn(api, "savePeriodEdit").mockRejectedValue(new ApiError("Deklaracje zmieniły się. Odśwież dane.", 409));
    try {
      await selectHistoricalPlan(rendered.host);
      await invoke(button(formOf(rendered.host), "Usuń"), "onClick");
      await invoke(button(rendered.host, "Usuń ten okres"), "onClick");
      await flushUntil(() => save.mock.calls.length > 0);
      expect(save.mock.calls[0]?.[0]).toEqual({ revision: "rev-1", kind: "plan", replace: { account: "claude-2", from: "2026-02-28" }, row: null });
      await invoke(button(formOf(rendered.host), "Anuluj"), "onClick");
      const form = formOf(rendered.host);
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => !button(form, "Zapisz").hasAttribute("disabled"));
      await invoke(form, "onSubmit", { preventDefault() {} });
      await flushUntil(() => form.textContent.includes("Deklaracje zmieniły się"));
      expect(formOf(rendered.host)).toBeDefined();
      expect(button(form, "Odśwież")).toBeDefined();
    } finally { await cleanup(rendered, [preview, save]); }
  });

  async function dragEnd(host: TestNode, label: string) {
    const target = dragSurface(host, label);
    const currentTarget = {
      getBoundingClientRect: () => ({ left: 100, width: 50 }),
      parentElement: { getBoundingClientRect: () => ({ width: 1000 }) },
      setPointerCapture() {},
    };
    await invoke(target, "onPointerDown", { button: 0, clientX: 148, pointerId: 1, currentTarget });
    // The chart spans more than 200 days on 1000 px, so +10 px moves the end by roughly two days.
    await invoke(target, "onPointerMove", { clientX: 158 });
    await invoke(target, "onPointerUp", {});
  }

  test("a plan bar clicked without dragging marks its subscription row and saves nothing", async () => {
    const rendered = await render();
    const save = spyOn(api, "savePeriodEdit");
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      const target = dragSurface(rendered.host, "Max · ×20,");
      expect(target.className).toContain("is-tier-20");
      const currentTarget = { getBoundingClientRect: () => ({ left: 100, width: 50 }),
        parentElement: { getBoundingClientRect: () => ({ width: 1000 }) }, setPointerCapture() {} };
      await invoke(target, "onPointerDown", { button: 0, clientX: 120, pointerId: 1, currentTarget });
      await invoke(target, "onPointerUp", {});
      const table = nodes(rendered.host).find((node) => node.tagName === "TABLE" && node.attributes["aria-label"] === "Abonament")!;
      const row = nodes(table).filter((node) => node.tagName === "TR").slice(1)[0]!;
      expect(row.className).toBe("is-plan is-selected");
      expect(dragSurface(rendered.host, "Max · ×20,").className).toContain("is-selected");
      expect(save).not.toHaveBeenCalled();
      expect(formOf(rendered.host)).toBeUndefined();
    } finally { await cleanup(rendered, [save]); }
  });

  /** A drag proposes dates in the editor; nothing is written until the owner presses Zapisz there. */
  async function saveDragged(host: TestNode, save: { mock: { calls: unknown[] } }) {
    await flushUntil(() => { const form = formOf(host); return !!form && !button(form, "Zapisz").hasAttribute("disabled"); });
    expect(save.mock.calls).toHaveLength(0);
    const form = formOf(host)!;
    await invoke(form, "onSubmit", { preventDefault() {} });
    await flushUntil(() => save.mock.calls.length > 0);
  }

  test("dragging a period's end opens the editor with the moved date checked, and only Zapisz saves it", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview(), applied: true, view: fixture({ revision: "rev-2" }) });
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await dragEnd(rendered.host, "Max · ×20,");
      await saveDragged(rendered.host, save);
      const edit = save.mock.calls[0]![0];
      expect(preview.mock.calls[0]?.[0]).toEqual(edit);
      expect(edit.replace).toEqual({ account: "claude-2", from: "2026-02-28" });
      expect(edit.row?.from).toBe("2026-02-28T00:00:00.000Z");
      expect((edit.row?.until ?? "") > "2026-03-29T00:00").toBe(true);
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("a bar joining a reading and a declaration of the same plan is edited as one declaration over the whole bar", async () => {
    const view = fixture();
    view.planPeriods.push(plan({ id: 12, account: "claude-1", plan: "max-5x", from: "2026-09-13T00:00:00Z", until: "2026-09-18T00:00:00Z",
      origin: "declared", evidence: "correction", readings: 0 }));
    const rendered = await render(view);
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview(), applied: true, view: fixture({ revision: "rev-2" }) });
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await dragEnd(rendered.host, "Max · ×5,");
      await saveDragged(rendered.host, save);
      const edit = save.mock.calls[0]![0];
      expect(edit.replace).toEqual({ account: "claude-1", from: "2026-09-13T00:00:00Z" });
      expect(edit).toMatchObject({ kind: "plan", row: { plan: "max-5x" } });
      expect(edit.row?.from).toBe("2026-09-12T19:41:00.000Z");
      expect((edit.row?.until ?? "") > "2026-09-18T00:00").toBe(true);
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("a dragged change the check rejects shows its reasons in the editor and cannot be saved", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview({ errors: ["okresy nakładają się"] }));
    const save = spyOn(api, "savePeriodEdit");
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await dragEnd(rendered.host, "Max · ×20,");
      await flushUntil(() => formOf(rendered.host)?.textContent.includes("okresy nakładają się") ?? false);
      const form = formOf(rendered.host);
      expect(labelled(form, "Od").value).toBe("2026-02-28T00:00");
      expect(labelled(form, "Do").value > "2026-03-29T00:00").toBe(true);
      expect(button(form, "Zapisz").hasAttribute("disabled")).toBe(true);
      expect(save).not.toHaveBeenCalled();
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("an overlap that ending the earlier plan resolves is offered as one save that ends it", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview({ errors: ["nakładające się okresy"],
      endEarlier: { rows: [{ value: "max-5x", from: "2026-02-01", until: null }], errors: [] } }));
    const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview(), applied: true, view: fixture({ revision: "rev-2" }) });
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await dragEnd(rendered.host, "Max · ×20,");
      await flushUntil(() => formOf(rendered.host)?.textContent.includes("Max · ×5 · 2026-02-01 00:00 → trwa") ?? false);
      const form = formOf(rendered.host)!;
      expect(button(form, "Zapisz").hasAttribute("disabled")).toBe(true);
      await invoke(button(form, "Zakończ je w chwili rozpoczęcia i zapisz"), "onClick");
      await flushUntil(() => save.mock.calls.length > 0);
      expect(save.mock.calls[0]![0]).toMatchObject({ kind: "plan", end_earlier: true, replace: { account: "claude-2", from: "2026-02-28" } });
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("the assignments table lists the account's computers in range and a row click opens its editor", async () => {
    const rendered = await render();
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await invoke(button(rendered.host, "Komputery2"), "onClick");
      const table = nodes(rendered.host).find((node) => node.tagName === "TABLE" && node.attributes["aria-label"] === "Przypisania w tym zakresie")!;
      const rows = nodes(table).filter((node) => node.tagName === "TR").slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        "PC-B.claude-22026-08-012026-08-1514Twój wpis",
        "PC-A.claude2026-03-01 00:002026-03-10 00:009Z odczytów",
      ]);
      await invoke(rows[0]!, "onClick");
      expect(labelled(formOf(rendered.host), "Do").value).toBe("2026-08-15T00:00");
    } finally { await cleanup(rendered); }
  });

  test("the limit windows tab puts the account's windows on the plan axis and marks a plan change drop", async () => {
    const hour = 3_600_000, now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    const reset = now + 36 * hour, start = reset - 168 * hour, dropAt = start + 94 * hour;
    const window = (key: string, from: number, until: number, used: number, extra: Record<string, unknown> = {}) => ({
      key, counterKey: "claude:kind=value(weekly_all):group=none:scope=none", label: "7d", dateLabel: key, source: "probe",
      isCurrent: from <= now && now < until, usedPercent: used, percentBasis: "measured", elapsedPercent: null, ppAhead: null,
      windowHours: 168, startIso: iso(from), resetIso: iso(until), shape: null, tokensTotal: null, usd: null, note: null, scope: null,
      sublimits: [{ label: "Fable", usedPercent: used === 88 ? 96 : 0, percentBasis: "measured", tokensTotal: null, usd: null, note: null }],
      ...extra,
    });
    const windows = spyOn(api, "windows").mockResolvedValue({ account: "claude-1", provider: "claude", source: "probe", windows: [
      window("after", dropAt, reset, 12, { counterSegment: { startDrop: { before: 88, after: 0 }, endDrop: null } }),
      window("before", start, dropAt, 88, { counterSegment: { startDrop: null, endDrop: { before: 88, after: 0 } } }),
      { ...window("session", now - 2 * hour, now + 3 * hour, 8), windowHours: 5, label: "5h", sublimits: [] },
    ] } as never);
    const rendered = await render();
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      await invoke(button(rendered.host, "Okna limitu"), "onClick");
      await flushUntil(() => rendered.host.textContent.includes("Okno 7d"));
      expect(windows).toHaveBeenCalledWith({ account: "claude-1" }, expect.anything());
      expect(rendered.host.textContent).toContain("↳ Fable");
      // Five-hour bars are too narrow to read on the whole history; the 30-day range shows them.
      expect(rendered.host.textContent).not.toContain("Okno 5h");
      const table = nodes(rendered.host).find((node) => node.tagName === "TABLE" && node.attributes["aria-label"] === "Okna limitu w tym zakresie")!;
      const rows = nodes(table).filter((node) => node.tagName === "TR").slice(1).map((row) => row.textContent);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain("7d · trwa");
      expect(rows[1]).toContain("88%");
      expect(rows[1]).toContain("↓ licznik spadł 88% → 0% · zmiana planu");
      expect(nodes(rendered.host).some((node) => node.className === "account-history-drop")).toBe(true);
      await invoke(button(rendered.host, "30 dni"), "onClick");
      expect(rendered.host.textContent).toContain("Okno 5h");
      // The periods tab keeps its computers and subscriptions.
      await invoke(button(rendered.host, "Okresy"), "onClick");
      expect(rendered.host.textContent).toContain("PC-A");
    } finally { await cleanup(rendered, [windows]); }
  });

  test("the subscriptions table beside the computers lists the account's plans with amounts and a row click opens its editor", async () => {
    const rendered = await render();
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      const table = nodes(rendered.host).find((node) => node.tagName === "TABLE" && node.attributes["aria-label"] === "Abonament")!;
      const rows = nodes(table).filter((node) => node.tagName === "TR").slice(1);
      // Without billing cycles (this view reads none) the per-cycle price is unknown and the total is the declared payment.
      expect(rows.map((row) => row.textContent)).toEqual(["Max · ×20×202026-02-28 00:002026-03-28 00:0028—101,81 €Twój wpis✎Usuń"]);
      await invoke(rows[0]!, "onClick");
      expect(labelled(formOf(rendered.host), "Do").value).toBe("2026-03-28T00:00");
    } finally { await cleanup(rendered); }
  });

  test("an account whose last plan has ended reads as inactive, one without plan history as not established", async () => {
    const rendered = await render();
    try {
      const choice = (label: string) => findButton(rendered.host, label).textContent;
      expect(choice("account_0002@example.test")).toBe("account_0002@example.testNieaktywny");
      expect(choice("account_0006@example.test")).toBe("account_0006@example.testMax · ×5 od 12.09 · 1 komputer");
      expect(choice("account_0004@example.test")).toBe("account_0004@example.testPlan nieustalony · 1 komputer");
      // Accounts without a current plan read quieter in the rail.
      expect(findButton(rendered.host, "account_0002@example.test").className).toContain("is-quiet");
      expect(findButton(rendered.host, "account_0006@example.test").className).not.toContain("is-quiet");
      await selectAccount(rendered.host, "account_0002@example.test");
      expect(fact(rendered.host, "plan")).toBe("Plan terazNieaktywny");
    } finally { await cleanup(rendered); }
  });

  test("accounts without any period are folded, and computer bars show their dates with the basis as outline", async () => {
    const data = fixture();
    data.accounts.push({ provider: "gemini", id: "gemini-1", label: "account_0000@example.test", current: false });
    const rendered = await render(data);
    try {
      const choices = () => nodes(rendered.host).filter((node) => node.className.startsWith("account-periods-account-choice") && !node.className.includes("all-choice")).map((node) => node.textContent);
      expect(choices().some((text) => text.includes("account_0000@example.test"))).toBe(false);
      await invoke(button(rendered.host, "▸ Bez okresów · 1"), "onClick");
      expect(choices().some((text) => text.includes("account_0000@example.test"))).toBe(true);
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      expect(rendered.host.textContent).not.toContain("Konto używane");
      const declaredBar = dragSurface(rendered.host, "PC-B .claude-2,");
      expect(declaredBar.className).toContain("is-declared");
      expect(declaredBar.textContent).toContain("01.08 → 15.08");
      expect(dragSurface(rendered.host, "PC-A .claude,").className).not.toContain("is-declared");
      // The tables repeating the bars are tabs of one switcher: the subscription opens first, computers one click away.
      const tabs = nodes(rendered.host).filter((node) => node.attributes["data-detail-tab"]);
      expect(tabs.map((node) => [node.textContent, node.attributes["aria-selected"]])).toEqual([["Abonament1", "true"], ["Komputery2", "false"]]);
    } finally { await cleanup(rendered); }
  });

  test("the account header names the plan's start, the computers in use and breaks between plans", async () => {
    const data = fixture();
    data.planPeriods.push(plan({ id: 13, account: "claude-1", plan: "pro", from: "2026-06-01T00:00:00Z", until: "2026-08-01T00:00:00Z", origin: "declared" }));
    const rendered = await render(data);
    try {
      await selectAccount(rendered.host, "account_0006@example.test");
      expect(fact(rendered.host, "plan")).toBe("Plan terazMax · ×5od 2026-09-12 19:41");
      expect(fact(rendered.host, "computers")).toBe("Komputery teraz1PC-A");
      expect(fact(rendered.host, "breaks")).toBe("Przerwy bez planu1pokaż w tabeli →01.08–12.09");
    } finally { await cleanup(rendered); }
  });

  test("rejected declarations remain visible with the source path and errors", async () => {
    const rendered = await render(fixture({ declarations: { file: "${ARCHIVE}/config/account-periods.json", present: true, errors: ["okresy nakładają się"] } }));
    try {
      expect(rendered.host.textContent).toContain("odrzucony w całości");
      expect(rendered.host.textContent).toContain("okresy nakładają się");
    } finally { await cleanup(rendered); }
  });

  test("refresh after a conflict preserves exactly one editor when source dates change", async () => {
    const rendered = await render();
    const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
    const save = spyOn(api, "savePeriodEdit").mockRejectedValue(new ApiError("Odśwież dane", 409));
    try {
      await selectAccount(rendered.host, "account_0002@example.test");
      await invoke(button(rendered.host, "Cała historia"), "onClick");
      await invoke(bar(rendered.host, "PC-B .claude-2,"), "onClick");
      const form = formOf(rendered.host);
      await invoke(button(form, "Podgląd"), "onClick");
      await flushUntil(() => !button(form, "Zapisz").hasAttribute("disabled"));
      await invoke(form, "onSubmit", { preventDefault() {} });
      await flushUntil(() => form.textContent.includes("Odśwież dane"));
      const changed = fixture({ revision: "rev-2" });
      changed.accountPeriods.find((row) => row.id === 3)!.until = "2026-08-16";
      rendered.load.mockResolvedValue(changed);
      await invoke(button(form, "Odśwież"), "onClick");
      await flushUntil(() => rendered.load.mock.calls.length > 1);
      await act(async () => { await Promise.resolve(); });
      expect(nodes(rendered.host).filter((node) => node.tagName === "FORM")).toHaveLength(1);
      expect(labelled(formOf(rendered.host), "Do").value).toBe("2026-08-15T00:00");
      expect(button(formOf(rendered.host), "Zapisz").hasAttribute("disabled")).toBe(true);
      await invoke(button(formOf(rendered.host), "Anuluj"), "onClick");
      await invoke(findButton(rendered.host, "Wszystkie konta — przegląd"), "onClick");
      await invoke(findButton(rendered.host, "+ Dodaj okres planu"), "onClick");
      expect(nodes(rendered.host).filter((node) => node.tagName === "FORM")).toHaveLength(1);
    } finally { await cleanup(rendered, [preview, save]); }
  });

  test("selected plan exposes original conflicting evidence and only intersecting computers", async () => {
    const data = fixture();
    data.planPeriods = [plan({ id: 30, account: "claude-2", plan: "pro", from: "2026-03-01", until: "2026-03-09" }),
      plan({ id: 31, account: "claude-2", plan: "max-20x", from: "2026-03-01", until: "2026-03-09", origin: "declared" })];
    const rendered = await render(data);
    try {
      await selectHistoricalPlan(rendered.host);
      const places = nodes(rendered.host).find((node) => node.attributes["aria-label"] === "Miejsca w tym okresie")!;
      expect(places.textContent).toContain("PC-A .claude");
      expect(places.textContent).not.toContain("PC-B");
      expect(rendered.host.textContent).toContain("Zaobserwowany oryginał: pro");
    } finally { await cleanup(rendered); }
  });

  describe("plan price coverage", () => {
    const gap = (from: string, until: string, from_ts: string, until_ts: string, days: number) => ({ from, until, from_ts, until_ts, days, plans: [] });
    const subject = (row: Partial<PlanPriceCoverageSubject> & { id: string; provider: string }): PlanPriceCoverageSubject =>
      ({ account: row.id.split("::")[0]!, label: null, first: "2026-06-09", last: "2026-10-08", pieces: [], gaps: [], usd: null, ...row });
    const coverage = (): PlanPriceCoverage => ({ since: null, until: null, subjects: [
      subject({ id: "claude-1", provider: "claude", gaps: [
        gap("2026-06-18", "2026-06-30", "2026-06-18T00:00:00.000Z", "2026-07-01T00:00:00.000Z", 13),
        gap("2026-09-03", "2026-09-08", "2026-09-03T00:00:00.000Z", "2026-09-09T00:00:00.000Z", 6)] }),
      subject({ id: "claude-2", provider: "claude", first: "2026-02-28", last: "2026-03-27", usd: 101.81 }),
      subject({ id: "codex1::business", provider: "codex", usage_based: true, first: "2026-06-01", last: "2026-06-28",
        gaps: [gap("2026-06-01", "2026-06-28", "2026-06-01T00:00:00.000Z", "2026-06-29T00:00:00.000Z", 28)] }),
    ] });
    const unpricedBars = (host: TestNode) => nodes(host).filter((node) => node.className.includes("is-unpriced") && node.className.includes("account-history-bar"));

    test("the account header says which days have no plan price and each gap opens the plan editor on its dates", async () => {
      const rendered = await render(fixture(), "all", [], coverage());
      try {
        await flushUntil(() => rendered.host.textContent.includes("2 luki"));
        await selectAccount(rendered.host, "account_0006@example.test");
        expect(fact(rendered.host, "price")).toBe("Cena planunieznana19 dni aktywności bez ceny: 18.06–30.06 · 03.09–08.09");
        expect(nodes(rendered.host).some((node) => node.attributes.title?.includes("Projekty pokazują „brak ceny planu”"))).toBe(true);
        // Both gaps lie inside the plan lane in the warn style, explained in the legend.
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        expect(unpricedBars(rendered.host)).toHaveLength(2);
        expect(rendered.host.textContent).toContain("brak ceny (blokuje wycenę)");
        await invoke(button(rendered.host, "18.06–30.06"), "onClick");
        const form = formOf(rendered.host);
        expect(labelled(form, "Od").value).toBe("2026-06-18T00:00");
        expect(labelled(form, "Do").value).toBe("2026-07-01T00:00");
      } finally { await cleanup(rendered); }
    });

    test("a fully priced account names its cost, and a usage-billed pool says it has no monthly price", async () => {
      const rendered = await render(fixture(), "all", [], coverage());
      try {
        await flushUntil(() => rendered.host.textContent.includes("2 luki"));
        await selectAccount(rendered.host, "account_0002@example.test");
        expect(fact(rendered.host, "price")).toBe("Cena planu$101,81znana za cały okres aktywności (28.02.2026–27.03.2026)");
        expect(unpricedBars(rendered.host)).toHaveLength(0);
        await selectAccount(rendered.host, "account_0004@example.test");
        expect(fact(rendered.host, "price")).toBe("Cena planu · codex1::businessza zużycierozliczenie za zużycie — brak stałej ceny miesięcznej");
        expect(unpricedBars(rendered.host)).toHaveLength(0);
      } finally { await cleanup(rendered); }
    });

    test("a priced account's cost names its sources in a tooltip; a payment waiting for its NBP rate has no editor", async () => {
      const cycle = (source: "declared" | "repeated", usd: number | null) => ({ start: "2026-03-01T00:00:00.000Z", end: "2026-04-01T00:00:00.000Z",
        source, amount: 813, currency: "PLN", usd, fx: null });
      const piece = (usd: number | null, extra: object) => ({ plan: "pro", usd_per_month: null, from: "2026-03-01", until: "2026-03-10", days: 10, usd, source: "declared" as const, ...extra });
      const data = coverage();
      data.subjects[0] = { ...data.subjects[0]!, gaps: [{ ...gap("2026-06-18", "2026-06-30", "2026-06-18T00:00:00.000Z", "2026-07-01T00:00:00.000Z", 13), rate_pending: true }] };
      data.subjects[1] = { ...data.subjects[1]!, pieces: [piece(80, { cycle: cycle("declared", 215.84) }), piece(20, { cycle: cycle("repeated", 208.72) }),
        piece(1.81, { source: "rate-card" })] };
      const rendered = await render(fixture(), "all", [], data);
      try {
        await flushUntil(() => rendered.host.textContent.includes("1 luka"));
        await selectAccount(rendered.host, "account_0002@example.test");
        expect(nodes(rendered.host).find((node) => node.textContent === "$101,81" && node.attributes.title)?.attributes.title)
          .toBe("płatności $80,00 · powtórzone płatności $20,00 · karta stawek $1,81");
        await selectAccount(rendered.host, "account_0006@example.test");
        expect(fact(rendered.host, "price")).toBe("Cena planunieznana13 dni aktywności bez ceny: 18.06–30.06");
        expect(nodes(rendered.host).some((node) => node.tagName === "BUTTON" && node.textContent === "18.06–30.06")).toBe(false);
        expect(nodes(rendered.host).some((node) => node.attributes.title === "kurs NBP w drodze: pobierany w tle")).toBe(true);
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        expect(unpricedBars(rendered.host)).toHaveLength(0);
      } finally { await cleanup(rendered); }
    });

    test("the rail flags an account whose plan cost is unknown, not a usage-billed pool", async () => {
      const rendered = await render(fixture(), "all", [], coverage());
      try {
        await flushUntil(() => rendered.host.textContent.includes("2 luki"));
        expect(findButton(rendered.host, "account_0006@example.test").textContent).toContain("2 luki");
        expect(nodes(findButton(rendered.host, "account_0006@example.test")).find((node) => node.className.startsWith("account-periods-price-flag"))?.attributes.title).toBe("Brak ceny planu: 2 luki");
        expect(findButton(rendered.host, "account_0002@example.test").textContent).not.toContain("luk");
        expect(findButton(rendered.host, "account_0004@example.test").textContent).not.toContain("luk");
      } finally { await cleanup(rendered); }
    });

    test("the provider filter also filters the price coverage", async () => {
      const rendered = await render(fixture(), "codex", ["codex"], coverage());
      try {
        await flushUntil(() => rendered.host.textContent.includes("Cena planu"));
        expect(fact(rendered.host, "price")).toContain("Cena planu · codex1::businessza zużycie");
        expect(nodes(rendered.host).some((node) => node.className.startsWith("account-periods-price-flag"))).toBe(false);
      } finally { await cleanup(rendered); }
    });
  });

  describe("billing cycles", () => {
    const cycle = (row: Partial<BillingCycle> & { start: string; end: string }): BillingCycle => ({
      plan: "max-20x", basis: "declared", anchor_uncertain: false, cycle_months: 1, shortened: false, current: false,
      price: { amount: 101.81, currency: "EUR", source: "declared", usd: 118.5,
        fx: { currency: "EUR", day: "2026-02-28", rate: 4.2, usd_rate: 3.6084, effective_day: "2026-02-27", table: "041/A/NBP/2026" } }, catalog_usd: 200,
      windows: { share: 4, idle: 0.5, touched: 5, observed_share: 1 }, used_pp: 270, used_pct: 60, api_usd: 6526.4, capacity_usd: null, capacity: null, used_units: null, resets: null,
      to_date: null, projection: null, per_window_point: 0.2262, unmetered: null, others: [], flags: ["capacity_uncalibrated"],
      run: { from: row.start, anchor: row.start, until: null }, declared_from: null, ...row,
    });
    // The declared 28.02-28.03 period and a cycle from readings after it (no declaration covers it).
    const cycles: BillingCyclesView = { accounts: [{ provider: "claude", account: "claude-2", counter: "weekly_all", stale: false, cycles: [
      cycle({ start: "2026-02-28T00:00:00.000Z", end: "2026-03-28T00:00:00.000Z", declared_from: "2026-02-28" }),
      cycle({ start: "2026-03-28T00:00:00.000Z", end: "2026-04-28T00:00:00.000Z", basis: "observed", anchor_uncertain: true, used_pp: null, used_pct: null,
        price: { amount: 200, currency: "USD", source: "catalog" }, per_window_point: null, run: { from: "2026-03-28T00:00:00.000Z", anchor: "2026-03-28T00:00:00.000Z", until: null } }),
    ] }] };
    const subscriptionRows = (host: TestNode) => nodes(nodes(host).find((node) => node.tagName === "TABLE" && node.attributes["aria-label"] === "Abonament")!)
      .filter((node) => node.tagName === "TR").slice(1);
    /** The rows that carry a cycle (a period of one cycle carries it on its own row). */
    const cycleRows = (host: TestNode) => subscriptionRows(host).filter((row) => row.attributes["data-cycle-row"]);
    const tier = { label: "Max 20x", multiplier: 20 };
    const labelledButton = (host: TestNode, label: string) => {
      const found = nodes(host).find((node) => node.tagName === "BUTTON" && node.attributes["aria-label"] === label);
      if (!found) throw new Error("Missing button: " + label);
      return found;
    };

    test("the plan lane marks each cycle with its price and use; no row offers to confirm a guessed cycle", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        await invoke(button(rendered.host, "Abonament2"), "onClick");
        const marks = nodes(rendered.host).filter((node) => node.className.startsWith("account-history-cycle "));
        expect(marks.map((node) => [node.className, node.textContent])).toEqual([
          ["account-history-cycle is-declared", "101,81 € · 60%"],
          ["account-history-cycle is-observed is-uncertain", "≈$200"],
        ]);
        expect(cycleRows(rendered.host).map((row) => row.textContent)).toEqual([
          "Max · ×20 ≈—2026-03-28 00:002026-04-28 00:0031$200 kat.$2004,50—6526 / ——z odczytów✎",
          "Max · ×20×202026-02-28 00:002026-03-28 00:0028101,81 €$118,504,5060 %6526 / —$0,26Twój wpis✎Usuń",
        ]);
        // The rate behind the dollars stays in the tooltip.
        expect(cycleRows(rendered.host)[1]!.children[6]!.attributes.title).toBe("Dowód płatności · NBP 041/A/NBP/2026 2026-02-27: EUR 4,2000 PLN · USD 3,6084 PLN");
        expect(rendered.host.textContent).not.toContain("Potwierdź");
      } finally { await cleanup(rendered); }
    });

    test("the period row shows its one cycle's price; the editor shows the dollars", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        const row = subscriptionRows(rendered.host)[1]!;
        expect(row.textContent).toBe("Max · ×20×202026-02-28 00:002026-03-28 00:0028101,81 €$118,504,5060 %6526 / —$0,26Twój wpis✎Usuń");
        await invoke(row, "onClick");
        expect(formOf(rendered.host).textContent).toContain("≈ $118,50 · NBP 2026-02-27");
        expect(labelled(formOf(rendered.host), "Waluta").value).toBe("EUR");
      } finally { await cleanup(rendered); }
    });

    test("each declared period is one row with exactly its dates; ✎ opens that period and Usuń asks to remove exactly it", async () => {
      const data = fixture();
      data.planPeriods.push(
        plan({ id: 21, account: "claude-2", plan: "max-20x", from: "2026-03-28", until: "2026-04-28", origin: "declared", readings: 0, tier }),
        plan({ id: 22, account: "claude-2", plan: "max-20x", from: "2026-04-28", until: "2026-05-28", origin: "declared", amountMinor: 18000, currency: "EUR", readings: 0, tier }));
      const view: BillingCyclesView = { accounts: [{ ...cycles.accounts[0]!, cycles: [cycles.accounts[0]!.cycles[0]!,
        cycle({ start: "2026-03-28T00:00:00.000Z", end: "2026-04-28T00:00:00.000Z", declared_from: "2026-03-28",
          price: { amount: 101.81, currency: "EUR", source: "repeated", usd: 118.5, fx: cycles.accounts[0]!.cycles[0]!.price.fx } })] }] };
      const rendered = await render(data, "all", [], undefined, undefined, view);
      const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview(), applied: true, view: fixture({ revision: "rev-2" }) });
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Abonament3"));
        expect(subscriptionRows(rendered.host).map((row) => [row.className, row.children[0]!.textContent, row.children[2]!.textContent, row.children[3]!.textContent])).toEqual([
          ["is-plan", "Max · ×20", "2026-04-28 00:00", "2026-05-28 00:00"],
          ["is-plan", "Max · ×20", "2026-03-28 00:00", "2026-04-28 00:00"],
          ["is-plan", "Max · ×20", "2026-02-28 00:00", "2026-03-28 00:00"],
        ]);
        expect(subscriptionRows(rendered.host)[0]!.children[6]!.textContent).toBe("180 €");
        await invoke(bar(rendered.host, "Max · ×20 2026-03-28 00:00 – 2026-04-28 00:00"), "onClick");
        expect(labelled(formOf(rendered.host), "Od").value).toBe("2026-03-28T00:00");
        expect(labelled(formOf(rendered.host), "Do").value).toBe("2026-04-28T00:00");
        // Edit mode lists the periods alone: the cycles wait until Gotowe.
        expect(cycleRows(rendered.host)).toHaveLength(0);
        await invoke(button(formOf(rendered.host), "Anuluj"), "onClick");
        await invoke(labelledButton(rendered.host, "Usuń: Max · ×20 2026-04-28 00:00 – 2026-05-28 00:00"), "onClick");
        expect(formOf(rendered.host).textContent).toContain("Usunąć ten okres?");
        await invoke(button(rendered.host, "Usuń ten okres"), "onClick");
        await flushUntil(() => save.mock.calls.length > 0);
        expect(save.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: { account: "claude-2", from: "2026-04-28" }, row: null });
        await invoke(button(rendered.host, "Gotowe"), "onClick");
        expect(button(rendered.host, "Edytuj okresy")).toBeDefined();
      } finally { await cleanup(rendered, [save]); }
    });

    test("a stretch between two declared periods is a gap row; + Dodaj opens a new period on its dates", async () => {
      const data = fixture();
      data.planPeriods.push(plan({ id: 22, account: "claude-2", plan: "max-20x", from: "2026-04-28", until: "2026-05-28", origin: "declared", readings: 0, tier }));
      const rendered = await render(data, "all", [], undefined, undefined, { accounts: [{ ...cycles.accounts[0]!, cycles: [cycles.accounts[0]!.cycles[0]!] }] });
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Abonament3"));
        const gap = subscriptionRows(rendered.host)[1]!;
        expect([gap.className, gap.children[0]!.textContent, gap.children[2]!.textContent, gap.children[3]!.textContent, gap.children[11]!.textContent])
          .toEqual(["is-gap", "Przerwa", "2026-03-28 00:00", "2026-04-28 00:00", "Bez planu"]);
        await invoke(labelledButton(rendered.host, "Dodaj okres: Przerwa 2026-03-28 00:00 – 2026-04-28 00:00"), "onClick");
        const form = formOf(rendered.host);
        expect(labelled(form, "Od").value).toBe("2026-03-28T00:00");
        expect(labelled(form, "Do").value).toBe("2026-04-28T00:00");
      } finally { await cleanup(rendered); }
    });

    test("a click on the plan bar selects the billing period under it, and a hovered row outlines its period", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      const save = spyOn(api, "savePeriodEdit");
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await invoke(button(rendered.host, "Cała historia"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        const mark = () => nodes(rendered.host).find((node) => node.attributes["data-cycle"] === "2026-02-28T00:00:00.000Z")!;
        // The pointer lands in the middle of the declared cycle on a 1000 px track starting at x = 0.
        const middle = (parseFloat(mark().style.left!) + parseFloat(mark().style.width!) / 2) * 10;
        const target = dragSurface(rendered.host, "Max · ×20,");
        const currentTarget = { getBoundingClientRect: () => ({ left: 0, width: 1000 }),
          parentElement: { getBoundingClientRect: () => ({ left: 0, width: 1000 }) }, setPointerCapture() {} };
        await invoke(target, "onPointerDown", { button: 0, clientX: middle, pointerId: 1, currentTarget });
        await invoke(target, "onPointerUp", { clientX: middle });
        expect(mark().className).toContain("is-selected");
        expect(target.className).not.toContain("is-selected");
        const rows = cycleRows(rendered.host);
        expect(rows.map((row) => row.className)).toEqual(["is-plan", "is-plan is-selected"]);
        await invoke(rows[0]!, "onMouseEnter");
        const later = nodes(rendered.host).find((node) => node.attributes["data-cycle"] === "2026-03-28T00:00:00.000Z")!;
        expect(later.className).toContain("is-hovered");
        await invoke(rows[0]!, "onMouseLeave");
        expect(later.className).not.toContain("is-hovered");
        expect(save).not.toHaveBeenCalled();
        expect(formOf(rendered.host)).toBeUndefined();
      } finally { await cleanup(rendered, [save]); }
    });

    test("✎ on a declared period edits its row; the renewal day and an annual period are saved with it", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview({ billing: { provider: "claude", account: "claude-2", from: "2026-02-20T00:00:00.000Z" } }));
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        await invoke(button(rendered.host, "Abonament2"), "onClick");
        await invoke(bar(rendered.host, "Max · ×20 2026-02-28 00:00 – 2026-03-28 00:00"), "onClick");
        const form = formOf(rendered.host);
        expect(labelled(form, "Od").value).toBe("2026-02-28T00:00");
        await invoke(labelled(form, "Dzień odnowienia"), "onChange", { target: { value: "2026-02-20T00:00" } });
        await chooseOption(labelled(form, "Okres rozliczeniowy"), "12");
        await invoke(button(form, "Podgląd"), "onClick");
        await flushUntil(() => preview.mock.calls.length > 0);
        expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: { account: "claude-2", from: "2026-02-28" },
          row: { plan: "max-20x", from: "2026-02-28T00:00:00.000Z", anchor: "2026-02-20T00:00:00.000Z", cycle_months: 12 } });
        await flushUntil(() => form.textContent.includes("Przeliczone zostaną tylko okresy rozliczeniowe tego konta, od 2026-02-20 00:00"));
      } finally { await cleanup(rendered, [preview]); }
    });

    test("the server's pending reason words the recalculation: new readings move no row, a period change only the cycles it reaches", async () => {
      const stale = (pending: BillingCyclesView["accounts"][number]["pending"]): BillingCyclesView =>
        ({ accounts: cycles.accounts.map((entry) => ({ ...entry, stale: true, pending })) });
      for (const [pending, text, marks] of [
        [{ reason: "figures", from: null }, null, [false, false]],
        [{ reason: "periods", from: "2026-03-28T00:00:00.000Z" }, "Przeliczam od 28.03 — daty i ceny mogą się zmienić.", [true, false]],
        [{ reason: "rules", from: null }, "Przeliczam cykle według nowych zasad — daty i ceny mogą się zmienić.", [true, true]],
      ] as const) {
        const rendered = await render(fixture(), "all", [], undefined, undefined, stale(pending));
        try {
          await selectAccount(rendered.host, "account_0002@example.test");
          await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
          await invoke(button(rendered.host, "Abonament2"), "onClick");
          const status = nodes(rendered.host).find((node) => node.attributes.role === "status" && node.className.includes("ui-loading-status"))!;
          if (text) expect(status.textContent).toBe(text);
          else expect(status.attributes.title).toBe("Nowe odczyty — liczby odświeżą się za chwilę; daty cykli się nie zmienią.");
          expect(cycleRows(rendered.host).map((row) => row.className.includes("is-pending"))).toEqual([...marks]);
        } finally { await cleanup(rendered, []); }
      }
    });

    test("a saved edit shows its billing periods as being recalculated once the owner is done editing", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      const range = { provider: "claude", account: "claude-2", from: "2026-03-28T00:00:00.000Z" };
      const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview({ billing: range }));
      const save = spyOn(api, "savePeriodEdit").mockResolvedValue({ preview: emptyPreview({ billing: range }), applied: true, view: fixture({ revision: "rev-2" }) });
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        await invoke(button(rendered.host, "Abonament2"), "onClick");
        await invoke(bar(rendered.host, "Max · ×20 2026-02-28 00:00 – 2026-03-28 00:00"), "onClick");
        const form = formOf(rendered.host);
        await invoke(button(form, "Podgląd"), "onClick");
        await flushUntil(() => !button(form, "Zapisz").hasAttribute("disabled"));
        await invoke(form, "onSubmit", { preventDefault() {} });
        await flushUntil(() => save.mock.calls.length > 0 && formOf(rendered.host) === undefined);
        // While editing the table holds the periods alone; Gotowe brings the cycles back with the recalculation.
        expect(rendered.host.textContent).not.toContain("Przeliczam od 28.03");
        await invoke(button(rendered.host, "Gotowe"), "onClick");
        await flushUntil(() => rendered.host.textContent.includes("Przeliczam od 28.03 — daty i ceny mogą się zmienić."));
        // Only the cycle the edit reaches waits for its new values; the earlier one is final.
        expect(cycleRows(rendered.host).map((row) => row.className.includes("is-pending"))).toEqual([true, false]);
      } finally { await cleanup(rendered, [preview, save]); }
    });

    test("✎ on a cycle from readings starts a declaration of its run", async () => {
      const rendered = await render(fixture(), "all", [], undefined, undefined, cycles);
      const preview = spyOn(api, "previewPeriodEdit").mockResolvedValue(emptyPreview());
      try {
        await selectAccount(rendered.host, "account_0002@example.test");
        await flushUntil(() => rendered.host.textContent.includes("Abonament2"));
        await invoke(button(rendered.host, "Abonament2"), "onClick");
        await invoke(bar(rendered.host, "Max · ×20 2026-03-28 00:00 – 2026-04-28 00:00"), "onClick");
        const form = formOf(rendered.host);
        expect(labelled(form, "Od").value).toBe("2026-03-28T00:00");
        expect(labelled(form, "Do").value).toBe("");
        await invoke(button(form, "Podgląd"), "onClick");
        await flushUntil(() => preview.mock.calls.length > 0);
        expect(preview.mock.calls[0]?.[0]).toMatchObject({ kind: "plan", replace: null, row: { account: "claude-2", plan: "max-20x", evidence: "owner" } });
      } finally { await cleanup(rendered, [preview]); }
    });
  });
});
