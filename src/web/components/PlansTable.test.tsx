import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CalibrationStatus,
  PlanCapacityAbsentReason,
  PlanCapacityResult,
  PlanQuantity,
  PlanTokenQuantities,
  PrimarySource,
} from "../lib/api";
import { PLAN_TOKEN_TYPES } from "../lib/api";
import { PlansTable, type PlanTableRow, type PlanTableVersion } from "./PlansTable";

function present(n: number): PlanQuantity {
  return { value: n, absent: null };
}
function absent(reason: PlanCapacityAbsentReason): PlanQuantity {
  return { value: null, absent: reason };
}
function vec(fill: PlanQuantity, extra?: Partial<PlanTokenQuantities>): PlanTokenQuantities {
  const out = {} as PlanTokenQuantities;
  for (const t of PLAN_TOKEN_TYPES) out[t] = extra?.[t] ?? fill;
  return out;
}

function capacity(opts: {
  asOf: string;
  version: string;
  versionFrom: string | null;
  source: PrimarySource;
  cal: CalibrationStatus;
  accepted: number;
  spanHours: number;
  explanation: string;
  api?: PlanQuantity;
  refPresent?: boolean;
  refReason?: string | null;
}): PlanCapacityResult {
  const tokens = vec(present(0.2), {
    in_uncached: present(0.18),
    in_cache_read: present(0.7),
    in_cache_write_5m: present(0.02),
    in_cache_write_1h: present(0),
    out_total: present(0.1),
  });
  const api = opts.api ?? present(6.7);
  const apiAbsent = api.absent;
  return {
    cohort: {
      provider_group: "openai",
      plan_id: "codex-plus",
      plan_version: opts.version,
      version_from: opts.versionFrom,
      window_kind: "weekly",
    },
    as_of: opts.asOf,
    local_calibration: {
      tokens: {
        status: opts.cal,
        reason: opts.cal === "none" ? "no_accepted_windows" : "ok",
        vector: opts.cal === "none" ? vec(absent("no_accepted_windows")) : vec(present(100_000)),
        spread: opts.cal === "reliable" ? 0.04 : null,
        consistent: opts.cal === "reliable",
      },
      api: {
        status: apiAbsent ? "none" : opts.cal,
        reason: apiAbsent ?? "ok",
        usd_per_1pct: api,
        by_type: apiAbsent ? vec(absent(apiAbsent)) : vec(present(1)),
      },
      samples: {
        accepted: opts.accepted,
        rejected: 1,
        independent_windows: opts.accepted,
        span_hours: opts.spanHours,
        cadence_hours: 168,
        diagnostics: [],
      },
      explanation: opts.explanation,
    },
    default_reference: {
      present: opts.refPresent ?? opts.source === "default_reference",
      tokens_per_1pct: opts.refPresent === false ? null : {
        in_uncached: 80_000,
        in_cache_read: 400_000,
        in_cache_write_5m: 10_000,
        in_cache_write_1h: 0,
        out_total: 40_000,
      },
      source: opts.refPresent === false ? null : "catalog",
      reason: opts.refReason ?? (opts.refPresent === false ? "no_reference" : null),
      version_id: opts.version,
      version_from: opts.versionFrom,
    },
    primary: {
      source: opts.source,
      tokens_per_1pct: opts.source === "none" ? vec(absent("no_reference")) : vec(present(100_000)),
      api_usd_per_1pct: opts.source === "none" ? absent("no_reference") : api,
      token_profile: opts.source === "none" ? vec(absent("no_reference")) : tokens,
      provenance: {
        capacity: opts.source === "local_calibration" ? "measured" : opts.source === "default_reference" ? "single" : "none",
        price: apiAbsent ? "none" : "rate-card",
        source: opts.source,
      },
    },
    deviation: {
      local_vs_reference: opts.source === "local_calibration" ? 0.08 : null,
      reason: opts.source === "none" ? "no_reference" : null,
    },
    derived: {
      usd_per_1pct: opts.source === "none" ? absent("no_reference") : api,
      usd_per_1m: opts.source === "none" ? absent("no_reference") : present(12),
      tokens_at_100pct: opts.source === "none" ? vec(absent("no_reference")) : vec(present(10_000_000)),
      utilisation_pct: absent("current_usage_unknown"),
      headroom_pct: absent("current_usage_unknown"),
      leverage: present(4.1),
    },
  };
}

const LIFETIME_EXPLANATION = "4 accepted · span 672h ≥ cadence 168h · spread 4% ≤ 10%";

function plusRow(asOf: string, active: "2023-02-01" | "2025-08-28"): PlanTableRow {
  const v1 = capacity({
    asOf,
    version: "2023-02-01",
    versionFrom: "2023-02-01",
    source: "local_calibration",
    cal: "reliable",
    accepted: 4,
    spanHours: 672,
    explanation: LIFETIME_EXPLANATION,
  });
  const v2 = capacity({
    asOf,
    version: "2025-08-28",
    versionFrom: "2025-08-28",
    source: "default_reference",
    cal: "working",
    accepted: 1,
    spanHours: 80,
    explanation: "1 accepted · below reliability gate",
  });
  const versions: PlanTableVersion[] = [
    {
      version_id: "2023-02-01",
      from: "2023-02-01",
      usd_per_month: 20,
      limits: { window_hours: 5 },
      source: "docs",
      note: null,
      window_kind: "5h",
      capacity: v1,
    },
    {
      version_id: "2025-08-28",
      from: "2025-08-28",
      usd_per_month: 20,
      limits: { window_hours: 5, weekly_cap: true },
      source: "docs",
      note: "weekly cap",
      window_kind: "weekly",
      capacity: v2,
    },
  ];
  const activeCap = active === "2023-02-01" ? v1 : v2;
  return {
    plan_id: "codex-plus",
    label: "Plus",
    provider_group: "openai",
    provider_label: "OpenAI",
    active_version_id: active,
    active_from: active,
    usd_per_month: 20,
    limits: active === "2023-02-01" ? { window_hours: 5 } : { window_hours: 5, weekly_cap: true },
    window_kind: active === "2023-02-01" ? "5h" : "weekly",
    capacity: activeCap,
    versions,
  };
}

describe("PlansTable", () => {
  it("renders one stable Plan row even when the Plan has two versions", () => {
    const html = renderToStaticMarkup(<PlansTable rows={[plusRow("2026-03-01", "2025-08-28")]} asOf="2026-03-01" />);
    expect(html.match(/data-plan-id="codex-plus"/g)?.length).toBe(1);
    expect(html.includes("data-plan-history")).toBe(false);
  });

  it("shows the version in force on the date fixture, not a version row identity", () => {
    const early = renderToStaticMarkup(<PlansTable rows={[plusRow("2024-06-01", "2023-02-01")]} asOf="2024-06-01" />);
    const late = renderToStaticMarkup(<PlansTable rows={[plusRow("2026-03-01", "2025-08-28")]} asOf="2026-03-01" />);
    expect(early).toContain('data-plan-id="codex-plus"');
    expect(early).toContain('data-version-id="2023-02-01"');
    expect(late).toContain('data-plan-id="codex-plus"');
    expect(late).toContain('data-version-id="2025-08-28"');
    expect(early).toContain('data-as-of="2024-06-01"');
    expect(late).toContain('data-as-of="2026-03-01"');
  });

  it("keeps full-lifetime calibration when Stan na dzień moves inside the same version", () => {
    const a = renderToStaticMarkup(
      <PlansTable rows={[plusRow("2024-03-01", "2023-02-01")]} asOf="2024-03-01" expandedIds={["codex-plus"]} />
    );
    const b = renderToStaticMarkup(
      <PlansTable rows={[plusRow("2024-11-01", "2023-02-01")]} asOf="2024-11-01" expandedIds={["codex-plus"]} />
    );
    expect(a).toContain(LIFETIME_EXPLANATION);
    expect(b).toContain(LIFETIME_EXPLANATION);
    expect(a).toContain('data-lifetime-accepted="4"');
    expect(b).toContain('data-lifetime-accepted="4"');
    expect(a).toContain('data-lifetime-span="672"');
    expect(b).toContain('data-lifetime-span="672"');
    expect(a).toContain("lifetime calibration");
  });

  it("marks reference fallback without hiding the local status", () => {
    const html = renderToStaticMarkup(<PlansTable rows={[plusRow("2026-03-01", "2025-08-28")]} asOf="2026-03-01" />);
    expect(html).toContain('data-primary-source="default_reference"');
    expect(html).toContain("reference");
    expect(html).toContain("local: working");
  });

  it("renders missing-rate as an em dash plus the server reason, never zero", () => {
    const row = plusRow("2026-03-01", "2025-08-28");
    row.capacity = capacity({
      asOf: "2026-03-01",
      version: "2025-08-28",
      versionFrom: "2025-08-28",
      source: "local_calibration",
      cal: "reliable",
      accepted: 4,
      spanHours: 672,
      explanation: LIFETIME_EXPLANATION,
      api: absent("missing_rate"),
    });
    const html = renderToStaticMarkup(<PlansTable rows={[row]} asOf="2026-03-01" />);
    expect(html).toContain('data-api-absent="missing_rate"');
    expect(html).toContain("rate missing");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("—");
  });

  it("renders edit actions for stable plan row and expanded version history when onEditPlan is provided", () => {
    const html = renderToStaticMarkup(
      <PlansTable
        rows={[plusRow("2026-03-01", "2025-08-28")]}
        asOf="2026-03-01"
        expandedIds={["codex-plus"]}
        onEditPlan={() => {}}
      />
    );
    expect(html).toContain("edit in catalog");
    expect(html).toContain("edit version");
  });
});
