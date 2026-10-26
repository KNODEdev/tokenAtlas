import { describe, expect, test } from "bun:test";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import { CODEX_PROMOTIONS } from "../shared/codex-promotions";
import { cyclePromotion } from "./codex-promotions";
import { capacityRegimeFingerprint, replaceCapacityRegimes, resolveCapacityRegime, validatePlans, type CapacityRegime, type PlansConfig } from "./plans";
import type { PlansCatalog } from "./plans-catalog";
import { handlePlansSave, type AppContext } from "./api";

const catalog: PlansCatalog = { provider_groups: [{ id: "openai", aliases: ["codex"], label: "OpenAI", plans: [
  { plan_id: "codex-pro-20x", label: "Pro 20x", aliases: ["pro", "pro-20x"], versions: [] },
  { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [] },
] }] };
const cycle = { account: "codex1", plan: "pro", cycle_start: "2026-09-01T00:00:00Z", cycle_end: "2026-09-08T00:00:00Z", cycle_end_basis: "reset" } as CodexComparisonWindow;
const regime: CapacityRegime = { id: "boost", subscription: "codex1", factor: 2, from: "2026-09-01", until: "2026-09-07", window_kind: "weekly", source: "user", confirmed: true, enabled: true, source_url: "https://learn.chatgpt.com/docs/changelog", note: "Account-confirmed test terms" };
const resolve = (patch: Partial<CapacityRegime> = {}, window = cycle) => cyclePromotion(window, { capacity_regimes: [{ ...regime, ...patch }] }, catalog);

describe("promotion-free full-cycle capacity terms", () => {
  test("cache announcements never imply account capacity factors", () => {
    const announcements = CODEX_PROMOTIONS.filter(p => p.id === "codex-context-cache-20261016" || p.id === "codex-cache-retention-20261020");
    expect(announcements).toHaveLength(2);
    for (const announcement of announcements) {
      expect(announcement).toMatchObject({ kind: "policy", factor: null, until: null });
      expect(cyclePromotion({ ...cycle, cycle_start: "2026-10-16T00:00:00Z", cycle_end: "2026-10-23T00:00:00Z" }, {}, catalog))
        .toMatchObject({ status: "unknown", factor: null, regime_ids: [] });
    }
  });

  test("Pro 20x to 10x announcement never applies a capacity factor to existing accounts", () => {
    expect(CODEX_PROMOTIONS.find(p => p.id === "codex-pro-200-usage-cut-20260929")).toMatchObject({
      kind: "policy", factor: null, until: null, announced_at: "2026-09-29T06:41:17Z",
    });
    expect(cyclePromotion({ ...cycle, cycle_start: "2026-09-29T00:00:00Z", cycle_end: "2026-10-06T00:00:00Z" }, {}, catalog))
      .toMatchObject({ status: "unknown", factor: null, regime_ids: [] });
  });
  test("historical announcements do not invent a weekly end date, reset multiplier or per-account entitlement", () => {
    expect(CODEX_PROMOTIONS.find(p => p.id === "codex-app-launch-2026")).toMatchObject({ announced: "2026-02-02", until: null, factor: 2 });
    expect(CODEX_PROMOTIONS.filter(p => p.kind !== "allowance").every(p => p.factor === null)).toBe(true);
    expect(cyclePromotion(cycle, {}, catalog)).toMatchObject({ status: "unknown", factor: null });
  });
  test("global July announcements do not synthesize resets or a weekly capacity increase", () => {
    const july = CODEX_PROMOTIONS.filter(p => p.announced.startsWith("2026-07"));
    expect(july.map(p => p.kind)).toEqual(["reset", "window", "reset"]);
    expect(july.every(p => p.factor === null)).toBe(true);
    expect(july.find(p => p.kind === "window")).toMatchObject({ until: null, window_kind: "5h" });
    for (const [start, end] of [["2026-07-10", "2026-07-17"], ["2026-07-29", "2026-08-05"]]) {
      const original = { ...cycle, cycle_start: `${start}T00:00:00Z`, cycle_end: `${end}T00:00:00Z` };
      expect(cyclePromotion(original, {}, catalog)).toMatchObject({ status: "unknown", factor: null, regime_ids: [] });
      expect(original.cycle_end).toBe(`${end}T00:00:00Z`);
    }
  });
  test("inclusive UTC days cover a midnight-ended full cycle, preserving provenance", () => {
    expect(resolve()).toEqual({ status: "configured", factor: 2, regime_ids: ["boost"], notes: [regime.note!], sources: [regime.source_url!] });
    expect(resolve({ factor: 1 })).toMatchObject({ status: "configured", factor: 1 });
    expect(resolve({}, { ...cycle, cycle_end: "2026-09-08T00:00:01Z" })).toMatchObject({ status: "mixed", factor: null });
  });
  test("does not apply another account, plan, 5h or Spark offer to the main weekly meter", () => {
    for (const patch of [{ subscription: "codex2" }, { plan_id: "codex-plus" }, { window_kind: "5h" }, { window_kind: "spark-weekly" }]) {
      expect(resolve(patch)).toMatchObject({ status: "unknown", factor: null });
    }
    expect(resolve({ subscription: "CODEX1", plan_id: "codex-pro-20x" }).factor).toBe(2);
  });
  test("matches a plan-scoped term by the plan the window's readings report; a retired stage changes nothing", () => {
    const plans = { segments: [{ subscription: "codex1", plan: "plus", from: "2026-01-01" }], capacity_regimes: [{ ...regime, plan_id: "codex-pro-20x" }] };
    expect(cyclePromotion(cycle, plans, catalog).factor).toBe(2);
    expect(cyclePromotion({ ...cycle, plan: "plus" }, plans, catalog).factor).toBeNull();
  });
  test("does not time-average, multiply overlaps, or fill gaps with ordinary 1x", () => {
    const first = { ...regime, until: "2026-09-03" };
    const second = { ...regime, id: "ordinary", from: "2026-09-04", factor: 1 };
    expect(cyclePromotion(cycle, { capacity_regimes: [first, second] }, catalog).status).toBe("mixed");
    expect(cyclePromotion(cycle, { capacity_regimes: [first] }, catalog).status).toBe("mixed");
    expect(cyclePromotion(cycle, { capacity_regimes: [regime, second] }, catalog).status).toBe("invalid");
    expect(cyclePromotion(cycle, { capacity_regimes: [first, { ...second, factor: 2 }] }, catalog).factor).toBe(2);
  });
  test("unknown boundaries, unconfirmed, disabled, inferred or unbounded terms cannot set baseline capacity", () => {
    for (const patch of [{ confirmed: false }, { enabled: false }, { source: "inferred" as const }, { from: null }, { until: null }]) expect(resolve(patch).factor).toBeNull();
    expect(resolve({}, { ...cycle, cycle_start: null }).status).toBe("uncertain");
    expect(resolve({}, { ...cycle, cycle_end_basis: "uncertain" }).status).toBe("uncertain");
    expect(resolve({ from: "2026-02-30" }).status).toBe("invalid");
    expect(resolve({ factor: Number.NaN }).status).toBe("invalid");
  });
  test("unconfirmed and disabled drafts do not influence existing plan estimates", () => {
    for (const patch of [{ confirmed: false }, { enabled: false }]) {
      expect(resolveCapacityRegime({ capacity_regimes: [{ ...regime, ...patch }] }, { subscription: "codex1", day: "2026-09-03", window_kind: "weekly" }).source).toBe("default");
    }
    expect(validatePlans({ capacity_regimes: [regime, { ...regime, id: "draft", confirmed: false }] })).toEqual([]);
  });
});

test("promotion-only save preserves plans and other accounts, persists metadata, and rejects stale edits", async () => {
  const plans: PlansConfig = { segments: [{ subscription: "codex1", plan: "pro-20x", usd_per_month: 200 }], capacity_regimes: [{ ...regime, id: "other", subscription: "codex2" }] };
  const ctx = { plans, accounts: { subscriptions: [{ id: "codex1", vendor: "codex" }] }, rateCards: {} } as AppContext;
  let saved: PlansConfig | undefined;
  const post = (body: unknown) => handlePlansSave(ctx, new Request("http://localhost/api/plans", { method: "POST", body: JSON.stringify(body) }), next => { saved = next; });
  const response = await post({ subscription: "codex1", capacity_regimes: [regime], expected_capacity_regimes: [] });
  expect(response.status).toBe(200);
  expect(saved?.segments).toEqual(plans.segments);
  expect(saved?.capacity_regimes).toContainEqual(regime);
  expect(saved?.capacity_regimes).toContainEqual(plans.capacity_regimes![0]!);
  expect((await response.json()).rows[0].capacity_regimes[0]).toEqual(regime);
  expect((await post({ subscription: "codex1", capacity_regimes: [], expected_capacity_regimes: [] })).status).toBe(409);
  expect(ctx.plans.capacity_regimes).toHaveLength(2);
  for (const patch of [{ factor: 0 }, { from: "2026-02-30" }, { source_url: "javascript:alert(1)" }, { confirmed: "yes" }]) {
    expect((await post({ subscription: "codex1", capacity_regimes: [{ ...regime, ...patch }] })).status).toBe(400);
  }
  expect((await post({ subscription: "codex1", capacity_regimes: {} })).status).toBe(400);
  expect(capacityRegimeFingerprint([regime])).toBe(capacityRegimeFingerprint([{ ...regime, confirmed: undefined, enabled: undefined }]));
  expect(replaceCapacityRegimes({}, "codex1", [regime]).capacity_regimes![0]).toEqual(regime);
});
