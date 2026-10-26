import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanCapacityResult, PlanQuantity, PlanTokenQuantities } from "../lib/api";
import { PLAN_TOKEN_TYPES } from "../lib/api";
import { SubscriptionsTable, type SubscriptionTableRow } from "./SubscriptionsTable";
import { buildSubscriptionRows, subscriptionCapacityJobs } from "../lib/settings-rows";

function present(n: number): PlanQuantity {
  return { value: n, absent: null };
}
function vec(n: number): PlanTokenQuantities {
  const out = {} as PlanTokenQuantities;
  for (const t of PLAN_TOKEN_TYPES) out[t] = present(n);
  return out;
}

const assignedCapacity: PlanCapacityResult = {
  cohort: {
    provider_group: "openai",
    plan_id: "codex-plus",
    plan_version: "2023-02-01",
    version_from: "2023-02-01",
    window_kind: "weekly",
  },
  as_of: "2026-03-01",
  local_calibration: {
    tokens: { status: "reliable", reason: "ok", vector: vec(100_000), spread: 0.04, consistent: true },
    api: { status: "reliable", reason: "ok", usd_per_1pct: present(6.7), by_type: vec(1) },
    samples: {
      accepted: 4,
      rejected: 0,
      independent_windows: 4,
      span_hours: 672,
      cadence_hours: 168,
      diagnostics: [],
    },
    explanation: "reliable local",
  },
  default_reference: {
    present: true,
    tokens_per_1pct: {
      in_uncached: 80_000,
      in_cache_read: 400_000,
      in_cache_write_5m: 10_000,
      in_cache_write_1h: 0,
      out_total: 40_000,
    },
    source: "catalog",
    reason: null,
    version_id: "2023-02-01",
    version_from: "2023-02-01",
  },
  primary: {
    source: "local_calibration",
    tokens_per_1pct: vec(100_000),
    api_usd_per_1pct: present(6.7),
    token_profile: vec(0.2),
    provenance: { capacity: "measured", price: "rate-card", source: "local_calibration" },
  },
  deviation: { local_vs_reference: 0.08, reason: null },
  derived: {
    usd_per_1pct: present(6.7),
    usd_per_1m: present(12),
    tokens_at_100pct: vec(10_000_000),
    utilisation_pct: { value: null, absent: "current_usage_unknown" },
    headroom_pct: { value: null, absent: "current_usage_unknown" },
    leverage: present(4.1),
  },
};

const assigned: SubscriptionTableRow = {
  id: "codex1",
  provider_group: "openai",
  provider_label: "OpenAI",
  vendor: "codex",
  stage_kind: "assigned",
  plan_id: "codex-plus",
  plan_label: "Plus",
  plan_query: "plus",
  stage_from: "2023-02-01",
  stage_until: "2026-01-31",
  usd_per_month: 20,
  price_source: "version",
  capacity: assignedCapacity,
};

const gap: SubscriptionTableRow = {
  id: "codex1",
  provider_group: "openai",
  provider_label: "OpenAI",
  vendor: "codex",
  stage_kind: "gap",
  plan_id: null,
  plan_label: null,
  plan_query: null,
  stage_from: "2026-02-01",
  stage_until: "2026-04-30",
  usd_per_month: null,
  price_source: "none",
  gap_reason: "plan_gap",
  capacity: null,
};

const unmatched: SubscriptionTableRow = {
  id: "claude-work",
  provider_group: "anthropic",
  provider_label: "Anthropic",
  vendor: "claude",
  stage_kind: "unmatched",
  plan_id: null,
  plan_label: null,
  plan_query: "team-mystery",
  stage_from: "2026-01-01",
  stage_until: null,
  usd_per_month: null,
  price_source: "none",
  unmatched_reason: "no_match",
  capacity: null,
};

describe("SubscriptionsTable", () => {
  it("keeps cancellation/reactivation as one Subscription row with a visible gap", () => {
    const html = renderToStaticMarkup(<SubscriptionsTable rows={[gap]} asOf="2026-03-01" />);
    expect(html.match(/data-subscription-id="codex1"/g)?.length).toBe(1);
    expect(html).toContain('data-stage="gap"');
    expect(html).toContain("gap between plan periods");
    expect(html).toContain("—");
    expect(html).not.toContain("$0.00");
  });

  it("shows a declared \"no subscription\" at $0 with no limits to calibrate", () => {
    const [row] = buildSubscriptionRows([{ subscription: "claude-sm", vendor: "claude", fallback_usd_per_month: 200, capacity_regimes: [],
      plan_on_day: { plan: "none", plan_id: "none", basis: "declared", from: "2026-06-18", until: "2026-07-01" } }],
      { provider_groups: [{ id: "anthropic", label: "Anthropic", aliases: ["claude"], plans: [] }] }, new Map(), "2026-06-20", "all");
    expect(row).toMatchObject({ stage_kind: "no_plan", plan_id: null, plan_label: "No subscription", usd_per_month: 0, price_source: "no-plan", capacity: null });
    expect(subscriptionCapacityJobs([{ subscription: "claude-sm", vendor: "claude", fallback_usd_per_month: null, capacity_regimes: [],
      plan_on_day: { plan: "none", plan_id: "none", basis: "declared", from: null, until: null } }],
      { provider_groups: [{ id: "anthropic", label: "Anthropic", aliases: ["claude"], plans: [] }] }, "2026-06-20")).toEqual([]);
    const html = renderToStaticMarkup(<SubscriptionsTable rows={[row!]} asOf="2026-06-20" />);
    expect(html).toContain('data-stage="no_plan"');
    expect(html).toContain("No subscription");
    expect(html).toContain("$0.00");
    expect(html).toContain("no subscription, no limits");
    expect(html).not.toContain("price missing");
  });

  it("drops only the title when bare, keeping the as-of line", () => {
    const bare = renderToStaticMarkup(<SubscriptionsTable rows={[assigned]} asOf="2026-03-01" bare />);
    expect(bare).not.toContain("Price and calibration");
    expect(bare).toContain("as of 2026-03-01");
    expect(renderToStaticMarkup(<SubscriptionsTable rows={[assigned]} asOf="2026-03-01" />)).toContain("Price and calibration");
  });

  it("shows an unmatched Plan as a first-class unassigned state, never a guessed catalog row", () => {
    const html = renderToStaticMarkup(<SubscriptionsTable rows={[unmatched]} asOf="2026-03-01" />);
    expect(html).toContain('data-subscription-id="claude-work"');
    expect(html).toContain('data-stage="unmatched"');
    expect(html).toContain('data-plan-query="team-mystery"');
    expect(html).toContain("team-mystery");
    expect(html).toContain("not matched to catalog");
    expect(html).not.toContain('data-plan-id="claude-pro"');
  });

  it("marks a linked subscription without offering stage editing (decision 16)", () => {
    const html = renderToStaticMarkup(
      <SubscriptionsTable rows={[assigned, unmatched]} asOf="2026-03-01" selectedId="codex1" />
    );
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("Stage");
    expect(html).toContain('data-selected="1"');
    // Plan history sits on the same account's timeline now; the table no longer links away to it.
    expect(html).not.toContain("Plan history");
    expect(html).toContain("Plus");
    expect(html).toContain("$6.70");
  });

  it("shows declared, observed, and truly unassigned Plan states, marking an observed plan as observed", () => {
    const observed: SubscriptionTableRow = {
      ...assigned,
      id: "codex2",
      plan_id: "codex-pro-5x",
      plan_label: "Pro 5x",
      usd_per_month: 100,
      observed_plan_id: "codex-pro-5x",
      observed_plan_label: "Pro 5x",
      observed_from: "2026-02-03",
      observed_until: "2026-04-28",
    };
    const unassigned: SubscriptionTableRow = {
      ...gap,
      id: "gemini-empty",
      stage_kind: "unassigned",
      gap_reason: null,
      stage_from: null,
      stage_until: null,
    };
    const html = renderToStaticMarkup(
      <SubscriptionsTable rows={[assigned, observed, unassigned]} asOf="2026-03-01" />,
    );
    expect(html).toContain('data-display-stage="assigned"');
    expect(html).toContain('data-display-stage="observed"');
    expect(html).toContain("≈ Pro 5x");
    expect(html).toContain("observed");
    expect(html).toContain('title="2026-02-03 → 2026-04-28"');
    expect(html).toContain("$100.00");
    expect(html).toContain('data-subscription-id="gemini-empty"');
    expect(html).toContain("unassigned");
  });

  it("shows a plan without a catalog price as a missing price, never $0", () => {
    const html = renderToStaticMarkup(
      <SubscriptionsTable rows={[{ ...assigned, usd_per_month: null, price_source: "none" }]} asOf="2026-03-01" />,
    );
    expect(html).toContain("price missing");
    expect(html).not.toContain("$0.00");
  });
});
