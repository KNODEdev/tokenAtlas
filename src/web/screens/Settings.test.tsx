import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { preserveBrowserGlobals } from "../lib/test-dom-globals";
let restoreDom = () => {};
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type PlanSettingRow, type PlansCatalog, type RateCardsResponse } from "../lib/api";
import type { ScreenProps } from "../lib/screens";
import type { AccountPeriodsView } from "../../shared/account-periods";
import { PlansTable } from "../components/PlansTable";
import { Settings, buildCapacityJobs, buildPlanRows, buildSubscriptionRows, planEditorTarget, settingsTabOptions, windowKindOf } from "./Settings";
import { peekSettingsTab, requestSettingsTab, settingsPlace, takeSettingsTab } from "../lib/settings-link";
import { translate } from "../lib/i18n";
import { CodexSpeedEditor } from "../components/CodexSpeedEditor";
const catalog: PlansCatalog = {
  provider_groups: [
    {
      id: "openai",
      label: "OpenAI",
      aliases: ["codex", "openai"],
      plans: [
        {
          plan_id: "codex-plus",
          label: "Plus",
          versions: [
            {
              from: "2023-02-01",
              usd_per_month: 20,
              limits: { window_hours: 5 },
              default_reference: { absent: true, reason: "no vector" },
            },
          ],
        },
      ],
    },
    {
      id: "zai",
      label: "Z.AI",
      aliases: ["glm", "zai"],
      plans: [
        {
          plan_id: "glm-coding-pro",
          label: "GLM Coding Pro",
          versions: [
            {
              from: null,
              usd_per_month: null,
              limits: {},
              default_reference: { absent: true, reason: "unverified" },
            },
          ],
        },
      ],
    },
  ],
};
describe("Settings tabs", () => {
  it("shows three tabs without group labels, Accounts first, named apart from the Data sources screen", () => {
    const options = settingsTabOptions(translate);
    expect(options.map((option) => [option.value, option.label])).toEqual([
      ["accounts", "Accounts"], ["computers", "Computers and data"], ["pricing", "Price lists"],
    ]);
    const pl = settingsTabOptions((_en, plText) => plText);
    expect(pl.map((option) => option.label)).toEqual(["Konta", "Komputery i dane", "Cenniki"]);
    expect(pl.map((option) => option.label)).not.toContain("Źródła danych");
  });

  it("maps every area of the seven earlier tabs to its new place", () => {
    expect(settingsPlace("sources")).toEqual({ tab: "computers" });
    expect(settingsPlace("data")).toEqual({ tab: "computers", data: true });
    expect(settingsPlace("periods")).toEqual({ tab: "accounts" });
    expect(settingsPlace("subscriptions")).toEqual({ tab: "accounts", sections: ["price", "promotions"] });
    expect(settingsPlace("windows")).toEqual({ tab: "accounts", sections: ["windows"] });
    expect(settingsPlace("cadence")).toEqual({ tab: "accounts", sections: ["rhythm"] });
    expect(settingsPlace("plans")).toEqual({ tab: "pricing", pricing: "plans" });
    expect(settingsPlace("rates")).toEqual({ tab: "pricing", pricing: "models" });
  });

  it("hands a requested tab to the next Settings mount exactly once", () => {
    requestSettingsTab("periods");
    expect(peekSettingsTab()).toBe("periods");
    expect(takeSettingsTab()).toBe("periods");
    expect(takeSettingsTab()).toBeNull();
  });
});

describe("Subscriptions rows from account plan periods", () => {
  const priced: PlansCatalog = { provider_groups: [{ id: "openai", label: "OpenAI", aliases: ["codex", "openai"], plans: [
    { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [{ from: "2023-02-01", usd_per_month: 20 }] },
    { plan_id: "codex-mystery", label: "Mystery", aliases: ["mystery"], versions: [{ from: "2023-02-01", usd_per_month: null }] },
  ] }] };
  const row = (subscription: string, plan_on_day: PlanSettingRow["plan_on_day"], fallback: number | null = 200): PlanSettingRow =>
    ({ subscription, vendor: "codex", fallback_usd_per_month: fallback, plan_on_day, capacity_regimes: [] });
  const none = { plan: null, plan_id: null, basis: "none" as const, from: null, until: null };
  it("prices the period's plan by its catalog version, marks observed plans and never shows a missing price as 0", () => {
    const rows = buildSubscriptionRows([
      row("declared", { plan: "plus", plan_id: "codex-plus", basis: "declared", from: "2026-01-01", until: null }),
      row("observed", { plan: "plus", plan_id: "codex-plus", basis: "observed", from: "2026-09-09T15:11:32.698Z", until: null }),
      row("unpriced", { plan: "mystery", plan_id: "codex-mystery", basis: "declared", from: "2026-01-01", until: null }),
      row("unknown", { plan: "enterprise", plan_id: null, basis: "declared", from: "2026-01-01", until: null }),
      row("between", { plan: null, plan_id: null, basis: "gap", from: "2026-03-01", until: "2026-04-01" }),
      row("ended", { plan: null, plan_id: null, basis: "uncovered", from: "2026-07-11", until: null }),
      row("history-less", none),
    ], priced, new Map(), "2026-09-27", "all");
    expect(rows.map((r) => [r.id, r.stage_kind, r.plan_id, r.usd_per_month, r.price_source, r.gap_reason ?? r.unmatched_reason ?? null,
      r.observed_plan_label ?? null])).toEqual([
      ["declared", "assigned", "codex-plus", 20, "version", null, null],
      ["observed", "assigned", "codex-plus", 20, "version", null, "Plus"],
      ["unpriced", "assigned", "codex-mystery", null, "none", null, null],
      ["unknown", "unmatched", null, null, "none", "no_match", null],
      ["between", "gap", null, null, "none", "plan_gap", null],
      ["ended", "gap", null, null, "none", "outside_plan_periods", null],
      ["history-less", "unassigned", null, 200, "rate-card", null, null],
    ]);
  });
});
describe("Settings unknown window kind", () => {
  it("does not invent weekly or fetch capacity when catalog limits are empty", () => {
    expect(windowKindOf({})).toBeNull();
    expect(windowKindOf(undefined)).toBeNull();
    expect(windowKindOf({ window_hours: 5 })).toBe("5h");
    expect(windowKindOf({ weekly_cap: true })).toBe("weekly");
    const jobs = buildCapacityJobs(catalog, "2026-03-01");
    expect(jobs.some((j) => j.plan_id === "glm-coding-pro")).toBe(false);
    expect(jobs.some((j) => j.plan_id === "codex-plus" && j.window_kind === "5h")).toBe(true);
    expect(jobs.some((j) => j.window_kind === "weekly")).toBe(false);
    const rows = buildPlanRows(catalog, new Map(), "2026-03-01", "all");
    const glm = rows.find((r) => r.plan_id === "glm-coding-pro")!;
    const plus = rows.find((r) => r.plan_id === "codex-plus")!;
    expect(glm.window_kind).toBeNull();
    expect(glm.kind_absent_reason).toBe("unknown_window_kind");
    expect(glm.capacity).toBeNull();
    expect(plus.window_kind).toBe("5h");
    const html = renderToStaticMarkup(<PlansTable rows={rows} asOf="2026-03-01" />);
    expect(html).toContain('data-plan-id="glm-coding-pro"');
    expect(html).toContain('data-kind-absent="unknown_window_kind"');
    expect(html).toContain("window cadence not declared");
    expect(html).not.toMatch(/data-plan-id="glm-coding-pro"[^>]*data-window-kind="weekly"/);
  });
  it("does not borrow the first version's cadence when the active version omits limits", () => {
    const asOf = "2026-08-01";
    const later: PlansCatalog = {
      provider_groups: [
        {
          id: "openai",
          label: "OpenAI",
          aliases: ["codex", "openai"],
          plans: [
            {
              plan_id: "codex-plus",
              label: "Plus",
              versions: [
                {
                  from: "2023-02-01",
                  usd_per_month: 20,
                  limits: { window_hours: 5 },
                  default_reference: { absent: true, reason: "no vector" },
                },
                {
                  from: "2026-06-01",
                  usd_per_month: 20,
                  default_reference: { absent: true, reason: "v2 unpublished" },
                },
              ],
            },
          ],
        },
      ],
    };
    const jobs = buildCapacityJobs(later, asOf);
    expect(jobs.some((j) => j.plan_id === "codex-plus" && j.as_of === asOf)).toBe(false);
    expect(jobs.some((j) => j.plan_id === "codex-plus" && j.window_kind === "5h" && j.as_of === asOf)).toBe(false);
    const rows = buildPlanRows(later, new Map(), asOf, "all");
    const plus = rows.find((r) => r.plan_id === "codex-plus")!;
    expect(plus.active_version_id).toBe("2026-06-01");
    expect(plus.window_kind).toBeNull();
    expect(plus.kind_absent_reason).toBe("unknown_window_kind");
    expect(plus.capacity).toBeNull();
    const html = renderToStaticMarkup(<PlansTable rows={rows} asOf={asOf} />);
    expect(html).toContain('data-plan-id="codex-plus"');
    expect(html).toContain('data-kind-absent="unknown_window_kind"');
    expect(html).toContain("window cadence not declared");
  });
  it("planEditorTarget sets view to catalog and normalizes version focus", () => {
    const rowTarget = planEditorTarget("codex-plus");
    expect(rowTarget).toEqual({
      planId: "codex-plus",
      versionId: null,
      view: "catalog",
    });
    const versionTarget = planEditorTarget("codex-plus", "2025-01-01");
    expect(versionTarget).toEqual({
      planId: "codex-plus",
      versionId: "2025-01-01",
      view: "catalog",
    });
  });
  it("renders onEditPlan action labels in PlansTable row and version history", () => {
    const rows = buildPlanRows(catalog, new Map(), "2026-03-01", "all");
    const html = renderToStaticMarkup(
      <PlansTable
        rows={rows}
        asOf="2026-03-01"
        expandedIds={["codex-plus"]}
        onEditPlan={() => {}}
      />
    );
    expect(html).toContain("edit in catalog");
    expect(html).toContain("edit version");
  });
});
const emptyPeriods: AccountPeriodsView = { revision: "fixture", sources: [], accounts: [], accountPeriods: [], planPeriods: [],
  declarations: { file: "fixture", present: false, errors: [] } };
const boundaryRateCards: RateCardsResponse = {
  version: 1,
  currency: "USD",
  unit: "$/1M tokenów",
  subscriptions: [],
  monthly_total_usd: 0,
  vendors: [
    {
      vendor: "anthropic",
      verified: true,
      source: "fixture",
      notes: [],
      day_scoped: true,
      model_count: 1,
      models: [
        {
          model: "claude-boundary",
          note: null,
          confidence: "verified",
          proxy_for: null,
          priced: true,
          variants: [
            {
              kind: "period",
              label: "do 2026-08-31",
              from: null,
              until: "2026-08-31",
              rates: { in_uncached: 2, out_total: 10 },
            },
            {
              kind: "period",
              label: "od 2026-09-01",
              from: "2026-09-01",
              until: null,
              rates: { in_uncached: 3, out_total: 15 },
            },
            {
              kind: "mode",
              label: "fast mode",
              from: null,
              until: null,
              rates: { in_uncached: 6, out_total: 30 },
            },
          ],
        },
      ],
    },
  ],
};
describe("Settings shared rate snapshot", () => {
  let host: TestNode | null = null;
  let root: Root | null = null;
  const mocks: Array<{ mockRestore: () => void }> = [];
  it("edits a model's dated credit/API multipliers, rejects zero and refreshes after save", async () => {
    let saved = 0;
    const save = spyOn(api, "saveRateCard").mockResolvedValue(boundaryRateCards);
    mocks.push(save);
    host = installTestDom(); root = createRoot(host as unknown as Element);
    await act(async () => root!.render(<CodexSpeedEditor model={{ model: "gpt-6-astra", note: null, confidence: "official", proxy_for: null, priced: true, variants: [],
      codex_speed: { editable: true, api_editable: true, credit_multiplier: 2.5, api_multiplier: 2, valid_from: "2026-09-08", confidence: "official" } }} onSaved={() => saved++} />));
    await invoke(findByText(host, "BUTTON", "Configure Speed")!, "onClick");
    const credit = findByAttribute(host, "aria-label", "gpt-6-astra Speed limit multiplier")!;
    await invoke(credit, "onChange", { target: { value: "0" } });
    await invoke(findByText(host, "BUTTON", "Save Speed")!, "onClick");
    expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain("Enter multipliers");
    await invoke(credit, "onChange", { target: { value: "3,5" } });
    await invoke(findByAttribute(host, "aria-label", "gpt-6-astra Speed from date")!, "onChange", { target: { value: "2026-09-10" } });
    await invoke(findByText(host, "BUTTON", "Save Speed")!, "onClick");
    expect(save).toHaveBeenCalledWith({ vendor: "openai", model: "gpt-6-astra", codex_speed: { credit_multiplier: 3.5, api_multiplier: 2, valid_from: "2026-09-10" } });
    expect(saved).toBe(1);
  });
  afterEach(() => {
    try {
      act(() => root?.unmount());
    } finally {
      root = null;
      host = null;
      while (mocks.length) mocks.pop()!.mockRestore();
      restoreDom();
    }
  });
  it("mounts Settings, selects both sides of a rate boundary, and retains the date across tabs", async () => {
    const mountedCatalog: PlansCatalog = {
      provider_groups: [
        { id: "anthropic", label: "Anthropic", aliases: ["anthropic", "claude"], plans: [] },
      ],
    };
    mocks.push(
      spyOn(api, "sourceHealth").mockResolvedValue({ generated_at: "2026-09-15T12:00:00Z", local_machine: "fixture", older_after_hours: 24, sources: [] }),
      spyOn(api, "sourceProfiles").mockResolvedValue({ revision: "fixture", machine: "fixture", login: "fixture", declarations: [], resolved: [] }),
      spyOn(api, "plansCatalog").mockResolvedValue({ path: "fixture", catalog: mountedCatalog }),
      spyOn(api, "plans").mockResolvedValue({ path: "fixture", rows: [] }),
      spyOn(api, "rateCards").mockResolvedValue(boundaryRateCards),
      spyOn(api, "codexPricing").mockResolvedValue({ revision: "fixture", rules: [], long_context_premium: true }),
      spyOn(api, "health").mockResolvedValue({ unpriced: { tokens: 0, models: {} } } as never),
      spyOn(api, "cycles").mockResolvedValue({
        path: "fixture",
        default_history_windows: 40,
        min_history_period_hours: 24,
        rows: [],
      }),
      spyOn(api, "accountPeriods").mockResolvedValue(emptyPeriods),
      spyOn(api, "planPriceCoverage").mockResolvedValue({ since: null, until: null, subjects: [] }),
      spyOn(api, "billingCycles").mockResolvedValue({ accounts: [] }),
    );
    host = installTestDom();
    root = createRoot(host as unknown as Element);
    await act(async () => {
      root!.render(<Settings {...({} as ScreenProps)} />);
    });
    expect(findByAttribute(host, "data-settings-tab", "accounts")).not.toBeNull();
    await invoke(findByText(host, "BUTTON", "Price lists")!, "onClick");
    await flushUntil(() => findByAttribute(host!, "aria-label", "As of date") != null);
    const dateInput = findByAttribute(host, "aria-label", "As of date")!;
    await invoke(dateInput, "onChange", { target: { value: "2026-08-30" } });
    await invoke(findByAttribute(host, "data-detail-tab", "models")!, "onClick");
    await flushUntil(() => periodRows(host!).length > 0);
    expect(periodRows(host)).toHaveLength(2);
    expect(activeRows(host)).toHaveLength(1);
    expect(activeRows(host)[0]?.getAttribute("data-rate-variant-from")).toBe("origin");
    expect(activeRows(host)[0]?.textContent).toContain("active 2026-08-30");
    await invoke(dateInput, "onChange", { target: { value: "2026-09-02" } });
    expect(periodRows(host)).toHaveLength(2);
    expect(activeRows(host)).toHaveLength(1);
    expect(activeRows(host)[0]?.getAttribute("data-rate-variant-from")).toBe("2026-09-01");
    expect(activeRows(host)[0]?.textContent).toContain("active 2026-09-02");
    await invoke(findByText(host, "BUTTON", "Accounts")!, "onClick");
    expect(dateInput.value).toBe("2026-09-02");
    // Price lists come back on the view left open.
    await invoke(findByText(host, "BUTTON", "Price lists")!, "onClick");
    expect(dateInput.value).toBe("2026-09-02");
    await flushUntil(() => activeRows(host!).length > 0);
    expect(activeRows(host)).toHaveLength(1);
    expect(activeRows(host)[0]?.getAttribute("data-rate-variant-from")).toBe("2026-09-01");
  });
  it("lands every deep link on its new place: an account's open sections, the data section, plans and models", async () => {
    const plansRead = spyOn(api, "plans").mockResolvedValue({ path: "fixture", rows: [
      { subscription: "codex1", vendor: "codex", fallback_usd_per_month: null, capacity_regimes: [],
        plan_on_day: { plan: "plus", plan_id: "codex-plus", basis: "declared", from: "2026-01-01", until: null } },
    ] });
    const ratesRead = spyOn(api, "rateCards").mockImplementation(() => new Promise(() => {}));
    mocks.push(plansRead, ratesRead,
      spyOn(api, "plansCatalog").mockResolvedValue({ path: "fixture", catalog }),
      spyOn(api, "planCapacity").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "missingRates").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "codexPricing").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "accountPeriods").mockResolvedValue({ ...emptyPeriods,
        accounts: [{ provider: "codex", id: "codex2", label: "first@example.com", current: true },
          { provider: "codex", id: "codex1", label: "social@example.com", current: true }],
        planPeriods: [{ id: 1, provider: "codex", account: "codex2", plan: "plus", from: "2026-01-01", until: null, origin: "declared",
          firstSeen: null, lastSeen: null, readings: 0, evidence: "owner-declaration", note: null, amountMinor: null, currency: null }] }),
      spyOn(api, "planPriceCoverage").mockResolvedValue({ since: null, until: null, subjects: [] }),
      spyOn(api, "billingCycles").mockResolvedValue({ accounts: [] }),
      spyOn(api, "analysisRebuildStatus").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "historyCoverage").mockImplementation(() => new Promise(() => {})),
      // The data link opens the linked subscription's archive history once the sources are read.
      spyOn(api, "sourceHealth").mockResolvedValue({ generated_at: "2026-09-15T12:00:00Z", local_machine: "MAIN", older_after_hours: 24, sources: [
        { key: "main", subscription: "codex1", vendor: "codex", label: "social@example.com", machine: "MAIN", profile: "C:/Users/sample_a/.codex", archive: "C:/archive/MAIN",
          configured: true, historical: false, local: true, last_session: null, last_meter: null, last_attempt: null, error: null, status: "configured" }] }),
      spyOn(api, "sourceProfiles").mockImplementation(() => new Promise(() => {})));
    host = installTestDom(); root = createRoot(host as unknown as Element);
    await act(async () => root!.render(<Settings {...({ dataSettings: { area: "subscriptions", account: "codex1", since: "2026-09-01", until: "2026-09-30" } } as ScreenProps)} />));
    await flushUntil(() => findByAttribute(host!, "data-account-sections", "codex1") != null);
    expect(findByAttribute(host, "data-settings-tab", "accounts")).not.toBeNull();
    // The rail chose the linked account, not the one with the most plan periods.
    expect(findByAttribute(host, "aria-label", "social@example.com")).not.toBeNull();
    // The link opens its first section's tab under the timeline; the other sections stay one click away.
    expect(allNodes(host).filter((node) => node.getAttribute("data-account-section")).map((node) => node.getAttribute("data-account-section"))).toEqual(["price"]);
    expect(findByAttribute(host, "data-detail-tab", "promotions")).not.toBeNull();
    await flushUntil(() => findByAttribute(host!, "data-subscription-id", "codex1") != null);
    expect(findByAttribute(host, "data-subscription-id", "codex1")!.getAttribute("data-selected")).toBe("1");
    expect(ratesRead).not.toHaveBeenCalled();
    await act(async () => root!.render(<Settings {...({ dataSettings: { area: "data", account: "codex1" } } as ScreenProps)} />));
    expect(findByAttribute(host, "data-settings-tab", "computers")).not.toBeNull();
    await flushUntil(() => findByAttribute(host!, "data-settings-section", "data") != null);
    expect(findByAttribute(host, "data-detail-tab", "history")!.getAttribute("aria-selected")).toBe("true");
    await act(async () => root!.render(<Settings {...({ dataSettings: { area: "rates", account: "codex1" } } as ScreenProps)} />));
    expect(findByAttribute(host, "data-settings-tab", "pricing")).not.toBeNull();
    expect(ratesRead).toHaveBeenCalled();
    // The status bar's missing-rates button asks for the old "rates" area before opening Settings.
    await act(async () => root!.render(null));
    requestSettingsTab("rates");
    await act(async () => root!.render(<Settings {...({} as ScreenProps)} />));
    expect(findByAttribute(host, "data-settings-tab", "pricing")).not.toBeNull();
    expect(findByAttribute(host, "data-detail-tab", "models")!.getAttribute("aria-selected")).toBe("true");
  });
  it("opens source settings first, selects one subscription and saves a local assignment without loading analysis", async () => {
    const source = { key: "laptop", subscription: "kuba", vendor: "codex", label: "Kuba", machine: "LAPTOP", profile: "C:/Users/sample_a/.codex-mr",
      archive: null, configured: false, historical: false, local: true, last_session: null, last_meter: "2026-09-15T12:00:00Z", last_attempt: null, error: null,
      status: "missing-assignment" as const };
    const catalogRead = spyOn(api, "plansCatalog").mockResolvedValue({ path: "fixture", catalog });
    const cycleRead = spyOn(api, "cycles").mockResolvedValue({} as never);
    const save = spyOn(api, "saveSourceProfile").mockResolvedValue({ ok: true } as never);
    mocks.push(catalogRead, cycleRead, save,
      spyOn(api, "sourceHealth").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "sourceProfiles").mockResolvedValue({ inventory: { generated_at: "2026-09-15T12:00:00Z", local_machine: "LAPTOP", older_after_hours: 24, activity_pending: true, sources: [
        { ...source, key: "other", subscription: "other", label: "Other account", machine: "OTHER-PC", local: false },
        { ...source, key: "main", machine: "MAIN", local: false, configured: true, archive: "C:/archive/MAIN-agy11" }, source,
      ] }, revision: "v1", machine: "LAPTOP", login: "sample_a", declarations: [
        { vendor: "codex", machine: "MAIN", home: "${ARCHIVE}/codex/MAIN-agy11", source_home: source.profile },
      ], resolved: [{ archive: "C:/archive/MAIN-agy11", profile: source.profile }] }));
    mocks.push(spyOn(api, "analysisRebuildStatus").mockImplementation(() => new Promise(() => {})),
      spyOn(api, "historyCoverage").mockImplementation(() => new Promise(() => {})));
    host = installTestDom(); root = createRoot(host as unknown as Element);
    // Data sources' "Profiles →" still asks for the old "sources" tab.
    requestSettingsTab("sources");
    await act(async () => root!.render(<Settings {...({ account: "other" } as ScreenProps)} />));
    await flushUntil(() => findByAttribute(host!, "aria-label", "Subscription to configure") != null);
    expect(findByAttribute(host, "data-settings-tab", "computers")).not.toBeNull();
    // Data and events follow the profiles on the same tab: the subscription's archive history and the rail's every-account entry.
    expect(findByAttribute(host, "data-detail-tab", "history")).not.toBeNull();
    expect(host.textContent).toContain("Archive and recalculation");
    expect(findByAttribute(host, "data-source-machine", "OTHER-PC")).not.toBeNull();
    expect(findByAttribute(host, "data-source-machine", "MAIN")).toBeNull();
    expect(catalogRead).not.toHaveBeenCalled(); expect(cycleRead).not.toHaveBeenCalled();
    await invoke(findByAttribute(host, "aria-label", "Codex · Kuba")!, "onClick");
    expect(findByAttribute(host, "data-source-machine", "OTHER-PC")).toBeNull();
    expect(findByAttribute(host, "data-source-machine", "MAIN")).not.toBeNull();
    // LAPTOP was detected by a limit reading but has no route: it is offered for assignment in a folded group.
    expect(findByAttribute(host, "data-source-machine", "LAPTOP")).toBeNull();
    await invoke(findByText(host, "BUTTON", "▸ Detected without assignment · 1")!, "onClick");
    await invoke(findByText(host, "BUTTON", "Assign")!, "onClick");
    await flushUntil(() => findByAttribute(host!, "aria-label", "Profile assignment") != null);
    const form = findByAttribute(host, "aria-label", "Profile assignment")!;
    expect(reactProps(form.parentNode!.parentNode!).colSpan).toBe(4);
    await invoke(form, "onSubmit", { preventDefault() {} });
    expect(save).toHaveBeenCalledWith({ revision: "v1", index: null, subscription: "kuba", vendor: "codex",
      profile: source.profile, archive: "${ARCHIVE}/codex/LAPTOP-sample_a-codex-mr" });
    expect(host.textContent).toContain("Saved");
    expect(catalogRead).not.toHaveBeenCalled(); expect(cycleRead).not.toHaveBeenCalled();
    await act(async () => root!.render(null));
    mocks.push(spyOn(api, "sourceProfiles").mockImplementation(() => new Promise(() => {})));
    requestSettingsTab("computers");
    await act(async () => root!.render(<Settings {...({ account: "kuba" } as ScreenProps)} />));
    expect(findByAttribute(host, "data-source-machine", "MAIN")).not.toBeNull();
    expect(host.textContent).not.toContain("Loading profiles");
  });
});
type TestNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  children: TestNode[];
  childNodes: TestNode[];
  style: Record<string, string> & { setProperty: (key: string, value: string) => void };
  attributes: Record<string, string>;
  ownerDocument: TestDocument | null;
  parentNode: TestNode | null;
  namespaceURI: string;
  className: string;
  id: string;
  _text: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  __handlers: Record<string, Array<(...args: unknown[]) => void>>;
  options?: TestNode[];
  appendChild: (child: TestNode) => TestNode;
  removeChild: (child: TestNode) => TestNode;
  insertBefore: (child: TestNode, ref: TestNode | null) => TestNode;
  setAttribute: (key: string, value: string) => void;
  getAttribute: (key: string) => string | null;
  removeAttribute: (key: string) => void;
  hasAttribute: (key: string) => boolean;
  addEventListener: (type: string, fn: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  contains: (node: TestNode) => boolean;
  cloneNode: () => TestNode;
  focus: () => void;
  blur: () => void;
  textContent: string;
};
type TestDocument = {
  nodeType: number;
  HTMLIFrameElement: { new (): object };
  HTMLElement: { new (): object };
  Element: { new (): object };
  Node: { new (): object };
  createElement: (tag: string) => TestNode;
  createElementNS: (namespace: string, tag: string) => TestNode;
  createTextNode: (text: string) => TestNode;
  createComment: () => TestNode;
  createDocumentFragment: () => TestNode;
  getElementById: () => null;
  querySelector: () => null;
  querySelectorAll: () => [];
  addEventListener: (type: string, fn: (...args: unknown[]) => void) => void;
  removeEventListener: () => void;
  activeElement: TestNode | null;
  readyState: string;
  location: { href: string; origin: string; protocol: string };
  body: TestNode;
  documentElement: TestNode;
  head: TestNode;
  defaultView: typeof globalThis;
};
function installTestDom(): TestNode {
  restoreDom = preserveBrowserGlobals();
  function MiniNode(this: TestNode, tag: string) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.nodeName = String(tag).toUpperCase();
    this.tagName = this.nodeName;
    this.children = [];
    this.childNodes = this.children;
    const style = { setProperty(key: string, value: string) { style[key] = value; } } as TestNode["style"];
    this.style = style;
    this.attributes = {};
    this.ownerDocument = null;
    this.parentNode = null;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.className = "";
    this.id = "";
    this._text = "";
    this.value = "";
    this.selected = false;
    this.disabled = false;
    this.__handlers = {};
  }
  MiniNode.prototype.appendChild = function (this: TestNode, child: TestNode) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  };
  MiniNode.prototype.removeChild = function (this: TestNode, child: TestNode) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  MiniNode.prototype.insertBefore = function (this: TestNode, child: TestNode, ref: TestNode | null) {
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    child.parentNode = this;
    return child;
  };
  MiniNode.prototype.setAttribute = function (this: TestNode, key: string, value: string) {
    this.attributes[key] = value;
    if (key === "class") this.className = value;
    if (key === "id") this.id = value;
  };
  MiniNode.prototype.getAttribute = function (this: TestNode, key: string) {
    return this.attributes[key] ?? null;
  };
  MiniNode.prototype.removeAttribute = function (this: TestNode, key: string) {
    delete this.attributes[key];
  };
  MiniNode.prototype.hasAttribute = function (this: TestNode, key: string) {
    return key in this.attributes;
  };
  MiniNode.prototype.addEventListener = function (this: TestNode, type: string, fn: (...args: unknown[]) => void) {
    (this.__handlers[type] ||= []).push(fn);
  };
  MiniNode.prototype.removeEventListener = function () {};
  MiniNode.prototype.dispatchEvent = function () { return true; };
  MiniNode.prototype.contains = function (this: TestNode, node: TestNode) {
    return node === this || this.children.some((child) => child.contains(node));
  };
  MiniNode.prototype.cloneNode = function (this: TestNode) {
    return new (MiniNode as unknown as { new (tag: string): TestNode })(this.tagName);
  };
  MiniNode.prototype.focus = function () {};
  MiniNode.prototype.blur = function () {};
  Object.defineProperty(MiniNode.prototype, "textContent", {
    get(this: TestNode) {
      if (this.nodeType === 3) return this._text;
      return this.children.map((child) => child.textContent).join("") || this._text || "";
    },
    set(this: TestNode, value: string) {
      this._text = String(value);
      this.children.length = 0;
    },
  });
  Object.defineProperty(MiniNode.prototype, "innerHTML", {
    get(this: TestNode) { return this.textContent; },
    set(this: TestNode, value: string) { this._text = String(value); },
  });
  Object.defineProperty(MiniNode.prototype, "firstChild", {
    get(this: TestNode) { return this.children[0] ?? null; },
  });
  Object.defineProperty(MiniNode.prototype, "lastChild", {
    get(this: TestNode) { return this.children[this.children.length - 1] ?? null; },
  });
  Object.defineProperty(MiniNode.prototype, "parentElement", {
    get(this: TestNode) { return this.parentNode; },
  });
  Object.defineProperty(MiniNode.prototype, "nextSibling", {
    get(this: TestNode) {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index + 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "previousSibling", {
    get(this: TestNode) {
      if (!this.parentNode) return null;
      const index = this.parentNode.children.indexOf(this);
      return this.parentNode.children[index - 1] ?? null;
    },
  });
  Object.defineProperty(MiniNode.prototype, "nodeValue", {
    get(this: TestNode) { return this._text || null; },
    set(this: TestNode, value: string) { this._text = value; },
  });
  Object.defineProperty(MiniNode.prototype, "options", {
    get(this: TestNode) {
      if (this.tagName !== "SELECT") return undefined;
      const out: TestNode[] = [];
      const walk = (nodes: TestNode[]) => {
        for (const node of nodes) node.tagName === "OPTION" ? out.push(node) : walk(node.children);
      };
      walk(this.children);
      return out;
    },
  });
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const addEventListener = (type: string, fn: (...args: unknown[]) => void) => {
    (listeners[type] ||= []).push(fn);
  };
  function HTMLIFrameElement() {}
  function HTMLElement() {}
  function Element() {}
  function Node() {}
  const doc = {
    nodeType: 9,
    HTMLIFrameElement,
    HTMLElement,
    Element,
    Node,
    createElement(tag: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })(tag);
      node.ownerDocument = doc as unknown as TestDocument;
      return node;
    },
    createElementNS(namespace: string, tag: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })(tag);
      node.ownerDocument = doc as unknown as TestDocument;
      node.namespaceURI = namespace;
      return node;
    },
    createTextNode(text: string) {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#text");
      node.nodeType = 3;
      node.nodeName = "#text";
      node._text = String(text);
      node.ownerDocument = doc as unknown as TestDocument;
      return node;
    },
    createComment() {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#comment");
      node.nodeType = 8;
      node.ownerDocument = doc as unknown as TestDocument;
      return node;
    },
    createDocumentFragment() {
      const node = new (MiniNode as unknown as { new (tag: string): TestNode })("#fragment");
      node.nodeType = 11;
      node.ownerDocument = doc as unknown as TestDocument;
      return node;
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener,
    removeEventListener() {},
    activeElement: null as TestNode | null,
    readyState: "complete",
    location: { href: "http://localhost/", origin: "http://localhost", protocol: "http:" },
    body: null as unknown as TestNode,
    documentElement: null as unknown as TestNode,
    head: null as unknown as TestNode,
    defaultView: globalThis,
  };
  doc.body = doc.createElement("body");
  doc.documentElement = doc.createElement("html");
  doc.head = doc.createElement("head");
  globalThis.document = doc as unknown as Document;
  globalThis.addEventListener = addEventListener as typeof globalThis.addEventListener;
  globalThis.removeEventListener = (() => {}) as typeof globalThis.removeEventListener;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1920 });
  Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 1080 });
  globalThis.navigator = { userAgent: "bun-test" } as Navigator;
  globalThis.HTMLIFrameElement = HTMLIFrameElement as unknown as typeof globalThis.HTMLIFrameElement;
  globalThis.HTMLElement = HTMLElement as unknown as typeof globalThis.HTMLElement;
  globalThis.Element = Element as unknown as typeof globalThis.Element;
  globalThis.Node = Node as unknown as typeof globalThis.Node;
  globalThis.SVGElement = function SVGElement() {} as unknown as typeof globalThis.SVGElement;
  globalThis.getComputedStyle = () => new Proxy({}, { get: () => "" }) as CSSStyleDeclaration;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  doc.defaultView = globalThis;
  const mountedHost = doc.createElement("div");
  doc.body.appendChild(mountedHost);
  return mountedHost;
}
function allNodes(root: TestNode): TestNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}
function findByAttribute(root: TestNode, name: string, value: string): TestNode | null {
  return allNodes(root).find((node) => node.getAttribute(name) === value) ?? null;
}
function findByText(root: TestNode, tag: string, text: string): TestNode | null {
  return allNodes(root).find((node) => node.tagName === tag && node.textContent === text) ?? null;
}
function reactProps(node: TestNode): Record<string, unknown> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props missing on ${node.tagName}`);
  return (node as unknown as Record<string, Record<string, unknown>>)[key]!;
}
async function invoke(node: TestNode, prop: "onClick" | "onChange" | "onSubmit", arg?: unknown): Promise<void> {
  const handler = reactProps(node)[prop];
  if (typeof handler !== "function") throw new Error(`${prop} missing on ${node.tagName}`);
  await act(async () => {
    handler(arg as never);
  });
}
function periodRows(root: TestNode): TestNode[] {
  return allNodes(root).filter((node) => node.getAttribute("data-rate-variant-kind") === "period");
}
function activeRows(root: TestNode): TestNode[] {
  return allNodes(root).filter((node) => node.getAttribute("data-rate-active") === "true");
}
async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("timed out waiting for mounted Settings to settle");
}
