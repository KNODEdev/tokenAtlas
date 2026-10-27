import { describe, expect, it, mock, spyOn } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CapacityEquivalents,
  Equivalent,
  ProjectCostResponse,
  Provenance,
  RepoBucketPoint,
  RepoHistoryResponse,
  SubjectCost,
  SubjectRow,
  SubjectSubscriptionSlice,
  SubscriptionSpend,
} from "../lib/api";
import { ProjectDrawer, type ProjectDrawerTab } from "./ProjectDrawer";
import { historyForRequest } from "./project-drawer/history";
import { ProjectMixChart } from "./project-drawer/ProjectMixChart";
import { ProjectTimeChart } from "./project-drawer/ProjectTimeChart";
import { SubscriptionSplitTable } from "./project-drawer/SubscriptionSplitTable";
import { WhatIfTable } from "./project-drawer/WhatIfTable";
import { CalibrationChip, ReceiptRow, ReceiptTable, subscriptionColor, type ReceiptLine } from "./mix";
import * as ui from "./ui";
import { SubjectRowView } from "../screens/ProjectUsage";
import { subscriptionNameLookup, type RosterCard } from "../lib/roster";
import { planUnits } from "../lib/planUnits";
const history: RepoHistoryResponse = {
  subject: { kind: "project", id: "alpha" },
  repo: null,
  granularity: "day",
  by: "none",
  idle_gap_minutes: 15,
  since: "2026-08-01",
  until: null,
  vendor_coverage: [],
  totals: {
    tokens: 0,
    calls: 0,
    active_seconds: 0, active_by_machine: {}, session_seconds: 0, 
    api_usd: 0,
    api_complete: true,
    billed_usd: 0,
    billed_complete: true,
    by_sub: {},
  },
  points: [],
  notes: [],
};
const equivalents: CapacityEquivalents = {
  full_5h_sessions: { value: null, absent: "no_capacity" },
  weekly_cycles: { value: null, absent: "no_capacity" },
  monthly_subscriptions: { value: null, absent: "no_capacity" },
};
const provenance: Provenance = {
  capacity: "none",
  price: "none",
  cadence: "none",
  calibration_covers_period: false,
  coverage: "none",
  measured_share: 0,
};
describe("ProjectDrawer guardrail repairs", () => {
  it("rejects retained drawer history after a subject switch or request error", () => {
    const state = { data: history, error: null, loading: false };
    expect(
      historyForRequest(state, {
        subject: { kind: "project", id: "beta" },
        granularity: "day",
        idleGap: 15,
        since: "2026-08-01",
      }),
    ).toBeNull();
    expect(
      historyForRequest(
        { ...state, error: "network failed" },
        {
          subject: history.subject,
          granularity: "day",
          idleGap: 15,
          since: "2026-08-01",
        },
      ),
    ).toBeNull();
    expect(
      historyForRequest(state, {
        subject: history.subject,
        granularity: "day",
        idleGap: 15,
        since: "2026-08-01",
      }),
    ).toBe(history);
  });
  it("keeps the matching history on screen while the same request reloads", () => {
    const request = { subject: history.subject, granularity: "day" as const, idleGap: 15, since: "2026-08-01" };
    expect(historyForRequest({ data: history, error: null, loading: true }, request)).toBe(history);
    expect(historyForRequest({ data: history, error: null, loading: true }, { ...request, idleGap: 30 })).toBeNull();
  });
  it("renders an unpriced billed allocation as absence while preserving a priced zero", () => {
    const missing = renderToStaticMarkup(
      <ReceiptRow
        label="bez ceny"
        billedUsd={null}
        equivalents={equivalents}
        provenance={provenance}
      />,
    );
    const pricedZero = renderToStaticMarkup(
      <ReceiptRow
        label="znane zero"
        billedUsd={0}
        equivalents={equivalents}
        provenance={{ ...provenance, price: "rate-card" }}
      />,
    );
    expect(missing).toContain("no declared price");
    expect(missing).not.toContain("$0.00");
    expect(pricedZero).toContain("$0.00");
    expect(pricedZero).not.toContain("no declared price");
  });
});
describe("ukrywanie liczb na wykresach", () => {
  const points: RepoBucketPoint[] = [
    {
      bucket: "2026-05-18",
      tokens: 1_234_567,
      calls: 42,
      active_seconds: 7200, active_by_machine: {}, session_seconds: 7200, 
      api_usd: 88.5,
      api_complete: true,
      billed_usd: 12.34,
      billed_complete: true,
      by_sub: { codex1: { api_usd: 88.5, billed_usd: 12.34 } },
    },
    {
      bucket: "2026-05-25",
      tokens: 2_000_000,
      calls: 50,
      active_seconds: 10800, active_by_machine: {}, session_seconds: 10800, 
      api_usd: 90,
      api_complete: true,
      billed_usd: 56.78,
      billed_complete: true,
      by_sub: { codex1: { api_usd: 90, billed_usd: 56.78 } },
    },
  ];
  const totals = { codex1: { api_usd: 178.5, billed_usd: 69.12 } };
  const colorOf = () => "var(--codex)";
  const codexCovered = {
    vendorBySub: { codex1: "codex" },
    vendorCoverage: [{ vendor: "codex", first: "2025-01-01", last: "2026-12-31" }],
  };
  it("draws the API catalog value when the history carries no allocated plan cost, and says so", () => {
    const apiOnly = points.map((p) => ({
      ...p,
      billed_usd: null,
      billed_complete: false,
      by_sub: { codex1: { api_usd: p.api_usd, billed_usd: null } },
    }));
    const html = renderToStaticMarkup(
      <ProjectMixChart
        title="usage history ($)"
        points={apiOnly}
        totalsBySub={{ codex1: { api_usd: 178.5, billed_usd: null } }}
        {...codexCovered}
        granularity="week"
        colorOf={colorOf}
        idleGap={15}
        fileName="x.png"
      />,
    );
    // One full-height bar per bucket (the larger week fills the plot), not 2px stubs.
    const heights = [...html.matchAll(/data-sub="codex1"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(heights).toHaveLength(2);
    expect(Math.max(...heights)).toBeGreaterThan(100);
    expect(html).toContain("Project traffic value at API prices · $ per week");
    expect(html).toContain("value at API prices: $90.00");
  });
  it("zdejmuje kwoty z legendy i dymków wykresu $, zostawiając daty i abonamenty", () => {
    const shown = renderToStaticMarkup(
      <ProjectMixChart
        points={points}
        totalsBySub={totals}
        {...codexCovered}
        granularity="week"
        colorOf={colorOf}
        idleGap={15}
        fileName="x.png"
      />,
    );
    const hidden = renderToStaticMarkup(
      <ProjectMixChart
        points={points}
        totalsBySub={totals}
        {...codexCovered}
        granularity="week"
        colorOf={colorOf}
        idleGap={15}
        hideValues
        fileName="x.png"
      />,
    );
    expect(shown).toContain("$69.12");
    expect(hidden).not.toContain("$69.12");
    expect(hidden).not.toContain("$12.34");
    expect(hidden).toContain("codex1");
    expect(hidden).toContain("05-18");
    expect(hidden).toContain("active time");
  });
  it("marks a mixed known+null stack as incomplete instead of fabricating a zero bar", () => {
    const mixed: RepoBucketPoint[] = [
      {
        bucket: "2026-08-10",
        tokens: 1000,
        calls: 2,
        active_seconds: 60, active_by_machine: {}, session_seconds: 60, 
        api_usd: 163.23,
        api_complete: false,
        billed_usd: 5,
        billed_complete: false,
        by_sub: {
          codex: { api_usd: 3.5, billed_usd: 5 },
          grok: { api_usd: 163.23, billed_usd: null },
        },
      },
    ];
    const html = renderToStaticMarkup(
      <ProjectMixChart
        points={mixed}
        totalsBySub={{
          codex: { api_usd: 3.5, billed_usd: 5 },
          grok: { api_usd: 163.23, billed_usd: null },
        }}
        vendorBySub={{ codex: "codex", grok: "grok" }}
        vendorCoverage={[
          { vendor: "codex", first: "2025-01-01", last: "2026-12-31" },
          { vendor: "grok", first: "2025-01-01", last: "2026-12-31" },
        ]}
        granularity="day"
        colorOf={(id) => (id === "codex" ? "var(--codex)" : "var(--grok)")}
        idleGap={15}
        fileName="mix.png"
      />,
    );
    expect(html).toContain("$5.00");
    expect(html).toContain("data-legend-sub=\"grok\"");
    expect(html).toContain("data-sub=\"codex\"");
    expect(html).not.toContain("data-sub=\"grok\"");
    expect(html).toContain("incomplete");
    expect(html).toContain("data-billed-incomplete");
    expect(html).toContain("grok: —");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("grok: $");
  });
  it("marks the API catalog incomplete only for an explicitly incomplete point", () => {
    const incomplete = renderToStaticMarkup(
      <ProjectMixChart
        points={[{ ...points[0]!, api_complete: false }]}
        totalsBySub={totals}
        {...codexCovered}
        granularity="week"
        colorOf={colorOf}
        idleGap={15}
        fileName="api-incomplete.png"
      />,
    );
    const complete = renderToStaticMarkup(
      <ProjectMixChart
        points={points}
        totalsBySub={totals}
        {...codexCovered}
        granularity="week"
        colorOf={colorOf}
        idleGap={15}
        fileName="api-complete.png"
      />,
    );
    expect(incomplete).toContain("API catalog");
    expect(incomplete).toContain("incomplete");
    expect(complete).not.toContain("API catalog: $88.50 · incomplete");
  });
  it("zdejmuje sumę godzin z wykresu czasu, zostawiając odniesienie etatu", () => {
    const shown = renderToStaticMarkup(
      <ProjectTimeChart points={points} granularity="week" idleGap={15} fileName="y.png" />,
    );
    const hidden = renderToStaticMarkup(
      <ProjectTimeChart points={points} granularity="week" idleGap={15} hideValues fileName="y.png" />,
    );
    expect(shown).toContain("total ≈ 5h 00m");
    expect(hidden).not.toContain("total ≈ 5h 00m");
    expect(hidden).toContain("•••");
    expect(hidden).toContain("full work capacity");
    expect(hidden).toContain("05-25");
  });
  it("stacks each wall-clock bar by computer, largest computer at the bottom, and keeps the session sum secondary", () => {
    // Parallel sessions: each computer's sessions add up to twice its wall-clock time.
    const bucket = (day: string, byMachine: Record<string, number>): RepoBucketPoint => {
      const wall = Object.values(byMachine).reduce((a, b) => a + b, 0);
      return {
        bucket: day, tokens: 1, calls: 1, active_seconds: wall, active_by_machine: byMachine,
        session_seconds: 2 * wall, api_usd: 0, api_complete: true, billed_usd: 0, billed_complete: true, by_sub: {},
      };
    };
    const split = [bucket("2026-10-05", { "EXAMPLE-MAIN": 3600, "EXAMPLE-LAPTOP-A": 7200 }), bucket("2026-10-12", { "EXAMPLE-LAPTOP-A": 3600, "?": 1800 })];
    const html = renderToStaticMarkup(<ProjectTimeChart points={split} granularity="week" idleGap={15} fileName="t.png" />);
    // Two segments in the first bar, laptop (3 h in the range) below the desktop (1 h); the unknown computer comes last.
    expect([...html.matchAll(/data-machine="([^"]+)"/g)].map((m) => m[1])).toEqual(["EXAMPLE-LAPTOP-A", "EXAMPLE-MAIN", "EXAMPLE-LAPTOP-A", "?"]);
    expect([...html.matchAll(/data-legend-machine="([^"]+)"/g)].map((m) => m[1])).toEqual(["EXAMPLE-LAPTOP-A", "EXAMPLE-MAIN", "?"]);
    expect(html).toContain("EXAMPLE-LAPTOP-A: ≈ 2h 00m");
    expect(html).toContain("Sessions summed: ≈ 6h 00m");
    expect(html).toContain("total ≈ 4h 30m");
    expect(html).toContain("sessions summed ≈ 9h 00m");
    expect(html).toContain("unknown computer");
    expect(html).toContain('fill="var(--violet)"');
    expect(html).toContain("vector-effect=\"non-scaling-stroke\"");
    const hidden = renderToStaticMarkup(<ProjectTimeChart points={split} granularity="week" idleGap={15} hideValues fileName="t.png" />);
    expect(hidden).not.toContain("EXAMPLE-LAPTOP-A: ≈");
    expect(hidden).toContain("EXAMPLE-LAPTOP-A</span><span style=\"color:var(--faint)\">≈ •••");
  });
  it("odróżnia okres przed pokryciem vendora od zmierzonego zera", () => {
    const coveragePoints: RepoBucketPoint[] = [
      {
        bucket: "2026-01-05",
        tokens: 1000,
        calls: 2,
        active_seconds: 60, active_by_machine: {}, session_seconds: 60, 
        api_usd: 3.5,
        api_complete: true,
        billed_usd: 5,
        billed_complete: true,
        by_sub: { work: { api_usd: 3.5, billed_usd: 5 } },
      },
      {
        bucket: "2026-08-10",
        tokens: 500,
        calls: 1,
        active_seconds: 30, active_by_machine: {}, session_seconds: 30, 
        api_usd: 3.5,
        api_complete: true,
        billed_usd: 5,
        billed_complete: true,
        by_sub: {
          work: { api_usd: 3.5, billed_usd: 5 },
          grok: { api_usd: 0, billed_usd: 0 },
        },
      },
    ];
    const html = renderToStaticMarkup(
      <ProjectMixChart
        points={coveragePoints}
        totalsBySub={{
          work: { api_usd: 7, billed_usd: 10 },
          grok: { api_usd: 0, billed_usd: 0 },
          orphan: { api_usd: 0, billed_usd: 0 },
        }}
        vendorBySub={{ work: "codex", grok: "grok" }}
        vendorCoverage={[
          { vendor: "codex", first: "2026-08-01", last: "2026-08-10" },
          { vendor: "grok", first: "2026-08-01", last: "2026-08-10" },
        ]}
        granularity="day"
        colorOf={(id) => (id === "work" ? "var(--codex)" : "var(--grok)")}
        idleGap={15}
        fileName="coverage.png"
      />,
    );
    expect(html).toContain("data-uncovered");
    expect(html).toContain('data-uncovered-subs="work grok orphan"');
    expect(html).toContain("work: no data");
    expect(html).toContain("grok: no data");
    expect(html).toContain("work: $5.00");
    expect(html).toContain("grok: $0.00");
    expect(html).toContain('data-uncovered-subs="orphan"');
  });
  it("wycina przyciski kopiowania i zapisu z eksportowanego obrazu", () => {
    const html = renderToStaticMarkup(
      <ProjectTimeChart points={points} granularity="week" idleGap={15} fileName="y.png" />,
    );
    expect(html).toContain("data-capture-exclude");
    expect(html).toContain("⧉");
    expect(html).toContain("↓ WebP");
    expect(html).toContain("Copy chart");
  });
});
describe("ReceiptTable", () => {
  const present = (value: number): Equivalent => ({ value, absent: null });
  const measured: Provenance = {
    capacity: "measured",
    price: "rate-card",
    cadence: "declared",
    calibration_covers_period: true,
  coverage: "full",
  measured_share: 1,
  };
  const calibrated: ReceiptLine = {
    subId: "codex1",
    plan: "pro",
    color: "var(--codex)",
    billedUsd: 419.14,
    costAtFullUseUsd: 200,
    apiUsd: 9000,
    equivalents: {
      full_5h_sessions: present(10.2),
      weekly_cycles: present(4.5),
      monthly_subscriptions: present(1),
    },
    provenance: measured,
  };
  const uncalibrated: ReceiptLine = {
    subId: "grok",
    plan: "xai",
    color: "var(--grok)",
    billedUsd: null,
    costAtFullUseUsd: null,
    apiUsd: 12,
    equivalents,
    provenance,
  };
  it("prints the counts, both prices and the overpay factor", () => {
    const html = renderToStaticMarkup(<ReceiptTable lines={[calibrated]} />);
    expect(html).toContain("≈ 4.5");
    expect(html).toContain("≈ 1");
    expect(html).toContain("≈ 10.2");
    expect(html).toContain("$419.14");
    expect(html).toContain("$200.00");
    expect(html).toContain("used 48%");
    expect(html).not.toContain("bargain");
    expect(html).toContain("measurement");
  });
  it("never prints a sum for the two capacity columns", () => {
    const html = renderToStaticMarkup(<ReceiptTable lines={[calibrated, uncalibrated]} />);
    expect(html.match(/not summed/g)).toHaveLength(2);
  });
  it("shows a missing price as absence and a missing estimate as a dash, never as zero", () => {
    const html = renderToStaticMarkup(<ReceiptTable lines={[uncalibrated]} />);
    expect(html.match(/>cost unavailable</g)).toHaveLength(2);
    expect(html).toContain("no calibration");
    expect(html).toContain("—");
    expect(html).not.toContain("≈ 0 ");
    expect(html).not.toContain("$0.00");
  });
  it("collapses the four provenance badges into one calibration answer", () => {
    const row = renderToStaticMarkup(<CalibrationChip provenance={measured} />);
    expect(row).toContain("measurement");
    expect(row).toContain("price rate card");
    expect(row).not.toContain(">declared<");
    expect(row).not.toContain(">rate card<");
    const outside = renderToStaticMarkup(
      <CalibrationChip
        provenance={{ ...measured, calibration_covers_period: false, coverage: "none", measured_share: 0 }}
      />,
    );
    expect(outside).toContain("period uncovered");
    const partial = renderToStaticMarkup(
      <CalibrationChip
        provenance={{ ...measured, calibration_covers_period: false, coverage: "partial", measured_share: 0.68 }}
      />,
    );
    expect(partial).toContain("coverage 68%");
  });
});
const drawerSubject: SubjectRow = {
  kind: "project",
  id: "alpha",
  name: "Alpha",
  group: null,
  tokens: 100,
  calls: 2,
  active_seconds: 3600,
  repos: [],
};
function mixFillNearId(html: string, id: string): string {
  const legend = html.match(new RegExp(`data-legend-sub="${id}"[\\s\\S]{0,400}?background:\\s*([^;"]+)`));
  if (legend?.[1]) return legend[1].trim();
  const swatch = html.match(new RegExp(`background:\\s*([^;"]+)[^>]*>\\s*</span>\\s*<span[^>]*>${id}<`));
  if (swatch?.[1]) return swatch[1].trim();
  throw new Error(`no MIX fill for ${id}`);
}
describe("ProjectDrawer cost error and shared MIX colour", () => {
  it("renders a failed project-cost request as a retryable error, not perpetual loading", () => {
    const html = renderToStaticMarkup(
      <ProjectDrawer
        subject={drawerSubject}
        cost={null}
        costLoading={false}
        costError="network failed"
        onCostRetry={() => {
          throw new Error("retry stub must not run");
        }}
        rangeDays={30}
        idleGap={15}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("network failed");
    expect(html).toContain("Retry");
    expect(html).toContain("error");
    expect(html).not.toContain("Loading project cost data...");
    expect((html.match(/error/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("invokes the real reload path from the rendered retry control", () => {
    const reload = mock(() => {});
    let renderedRetry: (() => void) | undefined;
    const spy = spyOn(ui, "ErrorState").mockImplementation(({ message, onRetry }) => {
      renderedRetry = onRetry;
      return <button type="button">{message}</button>;
    });
    try {
      renderToStaticMarkup(
        <ProjectDrawer
          subject={drawerSubject}
          cost={null}
          costLoading={false}
          costError="network failed"
          onCostRetry={reload}
          rangeDays={30}
          idleGap={15}
          onClose={() => {}}
        />,
      );
      expect(renderedRetry).toBe(reload);
      expect(reload).not.toHaveBeenCalled();
      renderedRetry?.();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("uses the same fill for an unknown id on the ranking and the drawer MIX surfaces", () => {
    const unknownId = "mystery-sub-9";
    const ranking = renderToStaticMarkup(
      <table>
        <tbody>
          <SubjectRowView
            row={drawerSubject}
            active={false}
            picked={false}
            maxApi={10}
            billed={4}
            apiUsd={10}
            mix={[
              {
                id: unknownId,
                plan: null,
                api: 10,
                billed: 4,
                weekly: { value: 1, absent: null },
                monthly: { value: 0.2, absent: null },
              },
            ]}
            sharePct={null}
            idleGap={15}
            onClick={() => {}}
            onPick={() => {}}
          />
        </tbody>
      </table>,
    );
    const drawer = renderToStaticMarkup(
      <ProjectMixChart
        points={[
          {
            bucket: "2026-08-10",
            tokens: 100,
            calls: 1,
            active_seconds: 60, active_by_machine: {}, session_seconds: 60, 
            api_usd: 10,
            api_complete: true,
            billed_usd: 4,
            billed_complete: true,
            by_sub: { [unknownId]: { api_usd: 10, billed_usd: 4 } },
          },
        ]}
        totalsBySub={{ [unknownId]: { api_usd: 10, billed_usd: 4 } }}
        vendorBySub={{ [unknownId]: "codex" }}
        vendorCoverage={[{ vendor: "codex", first: "2025-01-01", last: "2026-12-31" }]}
        granularity="day"
        colorOf={subscriptionColor}
        idleGap={15}
        fileName="colour.png"
      />,
    );
    const rankingFill = mixFillNearId(ranking, unknownId);
    const drawerFill = mixFillNearId(drawer, unknownId);
    expect(rankingFill).toBe(drawerFill);
    expect(rankingFill.length).toBeGreaterThan(0);
  });
});
const drawerSpend = (id: string, vendor: string, billed: number | null): SubscriptionSpend => ({
  id,
  vendor,
  plan: id === "codex1" ? "pro" : "super",
  usd_per_month: billed == null ? null : 20,
  usd_per_month_declared: billed == null ? null : 20,
  plan_periods: [],
  api_usd: 10,
  attributed_usd: 10,
  first_day: "2026-08-10",
  last_day: "2026-08-10",
  days: 1,
  paid_usd: billed,
  basis: billed == null ? "vendor" : "rate-card",
});
function drawerSlice(billed: number | null, apiUsd = 10): SubjectSubscriptionSlice {
  return {
    tokens: 100,
    api_usd: apiUsd,
    tokens_by_type: { in_uncached: 100, cache_read: 0, cache_write: 0, out: 0 },
    usd_by_type: null,
    billed_usd: billed,
    share: 1,
    calls: 1,
    seat_time: billed == null ? null : { months: 0, weeks: 0 },
    equivalents,
    cost_at_full_use_usd: null,
    provenance,
  };
}
function drawerSubjectCost(partial: Partial<SubjectCost>): SubjectCost {
  return {
    subject: "p:alpha",
    kind: "project",
    id: "alpha",
    tokens: 100,
    api_usd: 10,
    billed_usd: null,
    billed_complete: false,
    share_of_priced_spend_pct: null,
    priced_spend_usd: 5,
    calls: 1,
    by_sub: {},
    subscriptions: {},
    ...partial,
  };
}
function drawerCost(subject: SubjectCost, subscriptions: SubscriptionSpend[]): ProjectCostResponse {
  return {
    since: "2026-08-01",
    until: null,
    subscriptions,
    subjects: [subject],
    totals: {
      tokens: 100,
      calls: 1,
      api_usd: 10,
      paid_usd: subject.billed_usd ?? 0,
      billed_usd: subject.billed_usd ?? 0,
      unassigned_billed_usd: 0,
      unassigned_api_usd: 0,
      non_tmp_tokens: 100,
    },
    unpriced: { tokens: 0, models: {} },
    coverage: {
      tmp_bucket: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
      unassigned: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
      unpriced: { tokens: 0, calls: 0, api_usd: null, billed_usd: null, models: {} },
      unattributable: { tokens: 0, calls: 0, api_usd: null, billed_usd: null, vendor: "gemini" },
      totals: { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 },
    },
    notes: [],
  };
}
function renderDrawer(cost: ProjectCostResponse, tab: ProjectDrawerTab = "summary"): string {
  return renderToStaticMarkup(
    <ProjectDrawer
      subject={drawerSubject}
      cost={cost}
      costLoading={false}
      costError={null}
      since={cost.since ?? undefined}
      rangeDays={30}
      idleGap={15}
      onClose={() => {}}
      initialTab={tab}
    />,
  );
}

it("uses roster account names throughout project MIX while preserving separate subscription IDs and costs", () => {
  const ids = ["claude-ea41a81ab8dcf86d", "chatgpt-c4d0cf976ebfff8f"];
  const cards = ids.map((id, index) => ({
    id, group: index ? "codex" : "claude", vendorAccount: "owner@example.com",
    active: index === 0, plan: null, color: "var(--accent)", model: null,
  } as RosterCard));
  const nameOf = subscriptionNameLookup(cards);
  const spends = ids.map(id => drawerSpend(id, id.startsWith("claude") ? "claude" : "codex", 5));
  const subscriptions = Object.fromEntries(ids.map(id => [id, drawerSlice(5)]));
  const cost = drawerCost(drawerSubjectCost({ subscriptions, billed_usd: 10, billed_complete: true }), spends);
  const before = JSON.stringify(cost);
  const html = (["cost", "simulation"] as const).map(tab => renderToStaticMarkup(<ProjectDrawer subject={drawerSubject} cost={cost} cards={cards}
    since={cost.since!} rangeDays={30} idleGap={15} onClose={() => {}} initialTab={tab} />)).join("");
  // The split table (Cost tab) and the what-if table (Simulation tab) each name the subscription once per row.
  expect((html.match(/>owner@example.com</g) ?? []).length).toBe(4);
  for (const id of ids) expect(html).not.toContain(id);
  expect(JSON.stringify(cost)).toBe(before);
  expect(nameOf(ids[0]!.toUpperCase())).toBe("owner@example.com");
  expect(nameOf("unrecognized-account")).toBe("unrecognized-account");
  expect(planUnits(cards, spends).map(unit => ({ id: unit.id, label: unit.label, price: unit.usdPerMonth })))
    .toEqual(ids.map(id => ({ id, label: "owner@example.com · super", price: 20 })));

  const bySub = Object.fromEntries(ids.map(id => [id, { api_usd: 10, billed_usd: 5 }]));
  const chart = renderToStaticMarkup(<ProjectMixChart points={[{ bucket: "2026-08-10", tokens: 200, calls: 2,
    active_seconds: 60, active_by_machine: {}, session_seconds: 60,  api_usd: 20, billed_usd: 10, api_complete: true, billed_complete: true, by_sub: bySub }]}
    totalsBySub={bySub} granularity="day" colorOf={subscriptionColor} nameOf={nameOf}
    vendorBySub={Object.fromEntries(spends.map(spend => [spend.id, spend.vendor!]))}
    vendorCoverage={["claude", "codex"].map(vendor => ({ vendor, first: "2026-08-01", last: "2026-08-31" }))}
    idleGap={15} fileName="mix.png" />);
  for (const id of ids) {
    expect(chart).toContain(`data-legend-sub="${id}"`);
    expect(chart).not.toContain(`>${id}<`);
    expect(chart).not.toContain(`  ${id}:`);
  }
  expect(chart).toContain("owner@example.com: $5.00");
});
describe("ProjectDrawer subject billed completeness", () => {
  it("renders an all-null subject bill as unavailable, not $0", () => {
    const html = renderDrawer(
      drawerCost(drawerSubjectCost({ subscriptions: { grok: drawerSlice(null, 163.23) } }), [
        drawerSpend("grok", "grok", null),
      ]),
    );
    expect(html).toContain("data-billed-unavailable");
    expect(html).toContain("unavailable");
    expect(html).toContain("no subscription has a declared price");
    expect(html).not.toContain("data-billed-incomplete");
    expect(html).not.toContain("$0.00");
  });
  it("renders a mixed known subtotal as incomplete and keeps the null member", () => {
    const cost = drawerCost(
      drawerSubjectCost({
        billed_usd: 5.5,
        billed_complete: false,
        share_of_priced_spend_pct: 40,
        subscriptions: { grok: drawerSlice(null, 163.23), codex1: drawerSlice(5.5, 10) },
      }),
      [drawerSpend("codex1", "codex", 5.5), drawerSpend("grok", "grok", null)],
    );
    const html = renderDrawer(cost) + renderDrawer(cost, "cost");
    expect(html).toContain("$5.50");
    expect(html).toContain("data-billed-incomplete");
    expect(html).toContain("incomplete");
    expect(html).toContain("cost unavailable");
    expect(html).toContain("codex1");
    expect(html).toContain("grok");
    expect(html).not.toContain("data-billed-unavailable");
  });
  it("renders a fully priced measured zero as numeric 0 and complete", () => {
    const html = renderDrawer(
      drawerCost(
        drawerSubjectCost({
          billed_usd: 0,
          billed_complete: true,
          share_of_priced_spend_pct: 0,
          subscriptions: { codex1: drawerSlice(0, 10) },
        }),
        [drawerSpend("codex1", "codex", 0)],
      ),
    );
    expect(html).toContain("$0.00");
    expect(html).not.toContain("data-billed-incomplete");
    expect(html).not.toContain("data-billed-unavailable");
    // The Summary's billed figures carry no incompleteness; what-if capacity states live on the Simulation tab.
    expect(html).not.toContain('data-section="what-if"');
    expect(html).not.toContain("incomplete");
    expect(html).not.toContain("unavailable");
  });

  it("explains account conflicts for an incomplete allocation and keeps the old no-field behavior", () => {
    const conflicting = drawerCost(
      drawerSubjectCost({
        billed_usd: null,
        billed_complete: false,
        subscriptions: { claude: drawerSlice(null, 163.23) },
      }),
      [drawerSpend("claude", "claude", null)],
    );
    conflicting.coverage.conflicting_usage = {
      vendor: "claude",
      identities: 1,
      accounts: [{ account: "claude", identities: 1 }],
      tokens: null,
      api_usd: null,
      billed_usd: null,
      note: "synthetic conflict",
    };
    const conflictHtml = renderDrawer(conflicting);
    const plainHtml = renderDrawer(
      drawerCost(
        drawerSubjectCost({ billed_usd: null, billed_complete: false, subscriptions: { claude: drawerSlice(null, 163.23) } }),
        [drawerSpend("claude", "claude", null)],
      ),
    );

    expect(conflictHtml).toContain("Excluded conflicting Claude call identities: 1.");
    expect(conflictHtml).toContain("Account fee allocation is unavailable for: claude.");
    expect(conflictHtml).toContain("This evidence covers accounts and the selected period, not confirmed usage of this project.");
    expect(conflictHtml).toContain("allocation unavailable: conflicting usage");
    expect(conflictHtml).not.toContain("no subscription has a declared price");
    expect(plainHtml).toContain("no subscription has a declared price");
    expect(plainHtml).not.toContain("conflicting usage");
  });
});
describe("ProjectDrawer views", () => {
  const present = (value: number): Equivalent => ({ value, absent: null });
  const measured: Provenance = {
    capacity: "measured",
    price: "rate-card",
    cadence: "declared",
    calibration_covers_period: true,
    coverage: "full",
    measured_share: 1,
  };
  const line = {
    subId: "codex1",
    plan: "plus → pro",
    planHistory: "plus → pro",
    tokens: 2_500_000,
    color: "var(--codex)",
    billedUsd: 419.14,
    costAtFullUseUsd: 200,
    apiUsd: 9000,
    equivalents: { full_5h_sessions: present(10.2), weekly_cycles: present(4.5), monthly_subscriptions: present(1) },
    provenance: measured,
    seatTime: { weeks: 4, months: 0.9 },
    tokensByType: { in_uncached: 100_000, cache_read: 2_000_000, cache_write: 0, out: 400_000 },
    usdByType: { in_uncached: 1, cache_read: 2, cache_write: 0, out: 3 },
  };
  const planSpend = (): SubscriptionSpend => ({
    ...drawerSpend("codex1", "codex", 5.5),
    plan: "plus → pro",
    usd_per_month: 110,
    plan_periods: [
      { plan: "plus", usd_per_month: 20, from: "2026-08-01", until: "2026-08-05", days: 5, usd: 3.3, source: "declared" },
      { plan: "pro", usd_per_month: 200, from: "2026-08-06", until: "2026-08-10", days: 5, usd: 33, source: "observed" },
    ],
  });
  // IA-2026-10-19 PR-2: Summary, Timeline, Cost and subscriptions, Plan simulation, one panel open at a time.
  it("splits the drawer into four page tabs, each with its own questions", () => {
    const cost = drawerCost(
      drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, subscriptions: { codex1: drawerSlice(5.5, 10) } }),
      [drawerSpend("codex1", "codex", 5.5)],
    );
    const sections = (html: string) => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
    const summary = renderDrawer(cost);
    expect(summary.match(/role="tab"/g)).toHaveLength(4);
    expect([...summary.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Summary", "Timeline", "Cost and subscriptions", "Plan simulation"]);
    expect(summary).toMatch(/aria-selected="true" data-detail-tab="summary"/);
    expect(sections(summary)).toEqual(["cost", "shares"]);
    const timeline = renderDrawer(cost, "timeline");
    expect(sections(timeline)).toEqual(["time"]);
    // History is still loading in a static render; its controls stay in the section head.
    expect(timeline).toContain("Loading usage history");
    expect(timeline).toContain("values visible");
    const split = renderDrawer(cost, "cost");
    expect(sections(split)).toEqual(["subscriptions"]);
    // Capacity columns, the old glossary and the plan cards are not on screen by default.
    expect(split).toContain("more columns");
    expect(split).not.toContain("5h sessions");
    expect(split).not.toContain("weekly / monthly subs.");
    expect(split).not.toContain("Purchased subscription time");
    expect(split).not.toContain("convert all traffic to a subscription");
    // The simulation tab opens both hypothetical answers without a fold; a project also gets the plan simulation.
    const simulation = renderToStaticMarkup(
      <ProjectDrawer subject={drawerSubject} cost={cost} since={cost.since!} rangeDays={30} idleGap={15} onClose={() => {}} initialTab="simulation" />,
    );
    expect(sections(simulation)).toEqual(["what-if", "plan"]);
    expect(simulation).toContain("What if all traffic went through one subscription?");
    expect(simulation).toContain("Preparing project choices");
  });
  it("shows the priced traffic split by provider and by model on the Summary", () => {
    const cost = drawerCost(
      drawerSubjectCost({
        tokens: 300, api_usd: 40, billed_usd: 5.5, billed_complete: false,
        subscriptions: { codex1: drawerSlice(5.5, 30), claude1: { ...drawerSlice(null, 10), tokens: 200 } },
        models: { "gpt-5.5": { tokens: 100, calls: 1, api_usd: 30 }, "claude-opus-5-5": { tokens: 200, calls: 1, api_usd: 10 } },
      }),
      [drawerSpend("codex1", "codex", 5.5), drawerSpend("claude1", "claude", null)],
    );
    const html = renderDrawer(cost);
    const providers = html.slice(html.indexOf('data-shares="providers"'), html.indexOf('data-shares="models"'));
    expect([...providers.matchAll(/data-share-row="([^"]+)"/g)].map((m) => m[1])).toEqual(["codex", "claude"]);
    expect(providers).toContain(">Codex<");
    expect(providers).toContain(">75.0%<");
    expect(providers).toContain(">66.7%<");
    // A provider without a price shows absence, never $0, and takes no share of the known cost.
    expect(providers).toContain("no price");
    expect(providers).toContain(">100.0%<");
    // The ring draws one arc per part, largest API value first, with the total in its middle.
    expect([...providers.matchAll(/data-share-arc="([^"]+)"/g)].map((m) => m[1])).toEqual(["codex", "claude"]);
    expect(providers).toContain(">$40.00<");
    const models = html.slice(html.indexOf('data-shares="models"'));
    expect([...models.matchAll(/data-share-row="([^"]+)"/g)].map((m) => m[1])).toEqual(["gpt-5.5", "claude-opus-5-5"]);
    expect(models).not.toContain("subscriptions");
    // An older server without the model split says so instead of an empty table.
    const older = renderDrawer(drawerCost(drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, subscriptions: { codex1: drawerSlice(5.5, 10) } }),
      [drawerSpend("codex1", "codex", 5.5)]));
    expect(older).toContain("The model split needs a newer server.");
  });
  it("opens with a plain summary sentence and the subscription cost as the main figure", () => {
    const cost = drawerCost(
      drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, api_usd: 55, subscriptions: { codex1: drawerSlice(5.5, 10) } }),
      [drawerSpend("codex1", "codex", 5.5)],
    );
    const html = renderDrawer(cost);
    // Wall-clock time arrives with the history; until then neither the sentence nor the KPI shows the session sum as work.
    expect(html).toMatch(/data-summary=""[^>]*>Last \d+ days: 100 tokens across 1 subscription\.</);
    expect(html).toMatch(/Active time<\/div><div class="ui-figure ui-kpi-value">…<\/div>/);
    expect(html).toContain("sessions summed ≈ 1h 00m");
    expect(html).toContain("Cost from your subscriptions");
    expect(html).toMatch(/data-main-figure=""[^>]*>\$5\.50</);
    expect(html).toContain("Value at API prices");
    expect(html).toContain("= 10× what you paid");
    expect(html).toContain("Active time");
    expect(html).toContain("Traffic");
  });
  it("keeps the plan periods reachable in the plan chip's tooltip", () => {
    const cost = drawerCost(
      drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, subscriptions: { codex1: drawerSlice(5.5, 10) } }),
      [planSpend()],
    );
    // The chip on the what-if row names the current plan; the split row's chip carries the periods.
    const html = renderDrawer(cost, "cost") + renderDrawer(cost, "simulation");
    expect(html).toContain(">Pro · ×20<");
    const tip = html.match(/<span title="(plan from account periods[^"]*)"/)?.[1] ?? "";
    expect(tip).toContain("Plus · ×1 · $20.00 · declaration");
    expect(tip).toContain("Pro · ×20 · $200.00 · observed");
    expect(tip).toContain("avg. $110.00/month");
    expect(tip.split(/\n/)).toHaveLength(4);
    const bare = renderDrawer(
      drawerCost(drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, subscriptions: { codex1: drawerSlice(5.5, 10) } }), [
        drawerSpend("codex1", "codex", 5.5),
      ]),
      "simulation",
    );
    expect(bare).toContain("Price falls back to rate-cards.json.");
    // A stretch priced from a billing cycle shows the payment, its USD equivalent and the NBP rate behind it.
    const paid = planSpend();
    paid.plan_periods[1] = { ...paid.plan_periods[1]!, cycle: { start: "2026-08-06T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z", source: "repeated",
      amount: 813, currency: "PLN", usd: 208.72, fx: { currency: "PLN", day: "2026-08-06", rate: 1, usd_rate: 3.8952, effective_day: "2026-08-05", table: "151/A/NBP/2026" } } };
    const cycled = renderDrawer(drawerCost(drawerSubjectCost({ billed_usd: 5.5, billed_complete: true, subscriptions: { codex1: drawerSlice(5.5, 10) } }), [paid]), "cost");
    expect(cycled.match(/<span title="(plan from account periods[^"]*)"/)?.[1]).toContain("Pro · ×20 · 813.00 PLN ≈ $208.72 (NBP 2026-08-05, 3.8952) / cycle · repeated payment");
  });
  it("lists one what-if row per subscription, measured first, with a measurement tag for the rest", () => {
    const unit = (id: string, basis: "measured" | "single" | "none") => ({
      id, label: id, color: "var(--codex)", windowValue: basis === "none" ? null : 100, windowHours: 168,
      usdPerMonth: 200, basis, note: `${id} calibration note`,
    });
    const rows = [
      { subId: "none1", name: "none1", color: "var(--grok)", plan: null, planTooltip: null, unit: null, conv: null },
      { subId: "single1", name: "single1", color: "var(--codex)", plan: "plus", planTooltip: null, unit: unit("single1", "single"), conv: { windows: 2, parallel: 0.5, usd: 98.5 } },
      { subId: "meas1", name: "meas1", color: "var(--codex)", plan: "pro", planTooltip: null, unit: unit("meas1", "measured"), conv: { windows: 7.1, parallel: 1.6, usd: 326.04 } },
    ];
    const html = renderToStaticMarkup(<WhatIfTable rows={rows} rangeDays={30} />);
    expect(html.match(/<tr data-basis=/g)).toHaveLength(3);
    expect([...html.matchAll(/data-basis="([^"]+)"/g)].map((m) => m[1])).toEqual(["measured", "single", "none"]);
    for (const head of ["window", "full windows", "avg. use of 1 plan", "$ at 100%", "measurement"]) expect(html).toContain(`>${head}<`);
    expect(html).toContain("≈ 7.1");
    expect(html).toContain("≈ 160%");
    expect(html).toContain("≈ $326.04");
    expect(html).toContain("7 days");
    expect(html).toMatch(/title="single1 calibration note"[^>]*>1 reading</);
    expect(html).toMatch(/title="Window capacity calibration unavailable"[^>]*>no measurement</);
    expect(html).not.toContain("Purchased subscription time");
    expect(html).not.toContain("Capacity equivalent");
  });
  it("shows the compact split by default and the rest behind more columns", () => {
    const compactHtml = renderToStaticMarkup(<SubscriptionSplitTable lines={[line]} />);
    expect(compactHtml).toContain("$419.14");
    expect(compactHtml).toContain("$9,000.00");
    expect(compactHtml).toContain("2.5M");
    expect(compactHtml).toContain(">48%<");
    // Plan as one chip; the change history only in its tooltip.
    expect(compactHtml).toContain('title="plus → pro"');
    expect(compactHtml).toContain(">pro<");
    expect(compactHtml).not.toContain(">plus → pro<");
    expect(compactHtml).not.toContain("not summed");
    expect(compactHtml).not.toContain("≈ 4.5");
    const wide = renderToStaticMarkup(<SubscriptionSplitTable lines={[line]} moreColumns />);
    expect(wide).toContain("≈ 10.2");
    expect(wide).toContain("≈ 4.5");
    expect(wide).toContain("$200.00");
    expect(wide).toContain("4 weeks / 0.9 months");
    expect(wide.match(/not summed/g)).toHaveLength(2);
    expect(wide).toContain("measurement");
    expect(wide).toContain(">cache $<");
  });
  it("puts each column definition in its header tooltip", () => {
    const wide = renderToStaticMarkup(<SubscriptionSplitTable lines={[line]} moreColumns />);
    const headTitles = [...wide.matchAll(/<th[^>]*title="([^"]*)"/g)].map((m) => m[1]!).join(" | ");
    expect(headTitles).toContain("A counterfactual used for shares and capacity.");
    expect(headTitles).toContain("Above 100% (⚠) is impossible");
    expect(headTitles).toContain("purchased subscription time");
    expect(headTitles).toContain("It is not the percentage of limit used.");
    expect(headTitles).toContain("This is capacity, not time.");
    expect(headTitles).toContain("effective price per 1M");
  });
  it("moves each chart caption behind a help dot next to the chart title", () => {
    const points: RepoBucketPoint[] = [{
      bucket: "2026-05-18", tokens: 10, calls: 1, active_seconds: 3600, active_by_machine: {}, session_seconds: 3600,  api_usd: 1, api_complete: true,
      billed_usd: 1, billed_complete: true, by_sub: { codex1: { api_usd: 1, billed_usd: 1 } },
    }];
    const mix = renderToStaticMarkup(
      <ProjectMixChart title="usage history ($)" points={points} totalsBySub={{ codex1: { api_usd: 1, billed_usd: 1 } }}
        granularity="week" colorOf={() => "var(--codex)"} idleGap={15} fileName="m.png" />,
    );
    expect(mix).toContain("usage history ($)");
    expect(mix).toMatch(/role="tooltip"[^>]*hidden=""><span class="ui-help-block">Bars: \$ split by subscription/);
    const time = renderToStaticMarkup(
      <ProjectTimeChart title="time spent on the project (≈)" points={points} granularity="week" idleGap={15} fileName="t.png" />,
    );
    expect(time).toContain("time spent on the project (≈)");
    expect(time).toMatch(/role="tooltip"[^>]*hidden=""><span class="ui-help-block">Bars: wall-clock active hours per week/);
  });
});
describe("usage chart in % of window limit", () => {
  const unit = (id: string, basis: "measured" | "single" | "none", windowValue: number | null) => ({
    id, label: id, color: "var(--codex)", windowValue, windowHours: 168, usdPerMonth: 200, basis, note: `${id} note`,
  });
  const units = [unit("codex1", "measured", 100), unit("codex2", "single", 50), unit("grok", "none", null)];
  const points: RepoBucketPoint[] = [
    {
      bucket: "2026-08-03", tokens: 10, calls: 1, active_seconds: 3600, active_by_machine: {}, session_seconds: 3600,  api_usd: 106, api_complete: true,
      billed_usd: 9, billed_complete: true,
      by_sub: { codex1: { api_usd: 38, billed_usd: 5 }, codex2: { api_usd: 60, billed_usd: 4 }, grok: { api_usd: 8, billed_usd: null } },
    },
    {
      bucket: "2026-08-10", tokens: 10, calls: 1, active_seconds: 1800, active_by_machine: {}, session_seconds: 1800,  api_usd: 20, api_complete: true,
      billed_usd: 2, billed_complete: true, by_sub: { codex1: { api_usd: 20, billed_usd: 2 } },
    },
  ];
  const totals = { codex1: { api_usd: 58, billed_usd: 7 }, codex2: { api_usd: 60, billed_usd: 4 }, grok: { api_usd: 8, billed_usd: null } };
  const coverage = {
    vendorBySub: { codex1: "codex", codex2: "codex", grok: "grok" },
    vendorCoverage: ["codex", "grok"].map((vendor) => ({ vendor, first: "2026-01-01", last: "2026-12-31" })),
  };
  const render = (initialUnit: "usd" | "pct", hideValues = false) =>
    renderToStaticMarkup(
      <ProjectMixChart title="usage" points={points} totalsBySub={totals} {...coverage} units={units} initialUnit={initialUnit}
        granularity="week" colorOf={subscriptionColor} idleGap={15} hideValues={hideValues} fileName="pct.png" />,
    );
  it("keeps $ as the default unit and offers the switch", () => {
    const html = render("usd");
    expect(html).toMatch(/aria-pressed="true"[^>]*>\$</);
    expect(html).toContain("% of window limit");
    expect(html).not.toContain("data-limit-line");
    expect(html).toContain("Cost from your subscriptions · $ per week");
  });
  it("draws each subscription's spend over its own window capacity, side by side", () => {
    const html = render("pct");
    expect(html).toContain("Share of each subscription&#x27;s window limit · per week");
    const bucket = html.match(/data-pct-bucket="2026-08-03"[\s\S]*?<\/g>/)?.[0] ?? "";
    const rects = [...bucket.matchAll(/<rect data-sub="([^"]+)" data-pct="([^"]+)"[^>]*x="([^"]+)" y="([^"]+)"[^>]*width="([^"]+)" height="([^"]+)"/g)];
    expect(rects.map((m) => [m[1], m[2]])).toEqual([["codex1", "38.0"], ["codex2", "120.0"]]);
    // Grouped, not stacked: each bar starts on the baseline and they sit at different x.
    const [a, b] = rects.map((m) => ({ x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]) }));
    expect(a!.y + a!.h).toBeCloseTo(b!.y + b!.h, 5);
    expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.w);
    expect(bucket).toContain("codex1: 38% of one 7-day window ($38.00 of $100.00)");
    expect(bucket).toContain("codex2: 120% of one 7-day window ($60.00 of $50.00) · 1 reading");
    expect(bucket).toContain("grok: no window measurement");
  });
  it("draws the 100% limit line on a scale that reaches the highest bar", () => {
    const html = render("pct");
    expect(html).toContain("data-limit-line");
    expect(html).toContain("limit 100%");
    // The highest bar is 120%, so the limit line sits below the plot top (y = 8).
    const y = Number(html.match(/data-limit-line=""[^>]*y1="([^"]+)"/)?.[1]);
    expect(y).toBeGreaterThan(8);
    expect(y).toBeCloseTo(8 + 150 * (1 - 100 / 120), 5);
  });
  it("dims a single-reading bar and tags it; gives an unmeasured subscription no bar and a tag", () => {
    const html = render("pct");
    expect(html).toMatch(/data-sub="codex2"[^>]*data-single=""[^>]*fill-opacity="0.45"[^>]*stroke-dasharray/);
    expect(html).not.toMatch(/<rect data-sub="grok"/);
    expect(html).toMatch(/data-legend-sub="codex2"[\s\S]*?title="codex2 note"[^>]*>1 reading</);
    expect(html).toMatch(/data-legend-sub="grok"[\s\S]*?title="grok note"[^>]*>no measurement</);
    expect(html).toMatch(/data-legend-sub="codex1"[\s\S]*?peak 38%/);
  });
  it("hides the percentages with the values toggle but keeps the bars", () => {
    const html = render("pct", true);
    expect(html).not.toContain("38% of one");
    expect(html).not.toContain("peak 38%");
    expect(html).toContain('data-sub="codex1"');
  });
});
