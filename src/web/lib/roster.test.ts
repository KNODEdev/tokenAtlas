import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SubscriptionCards } from "../components/SubscriptionCards";
import { buildRoster } from "./roster";
import type { AccountStateRow, ApiCycle, RosterAccount, RosterProbe, RosterResponse } from "./api";

function state(overrides: Partial<AccountStateRow>): AccountStateRow {
  return {
    account: "codex2",
    limit_id: "codex",
    limit_name: null,
    plan_type: "plus",
    slot: "secondary",
    window_minutes: 10_080,
    used_percent: 24,
    resets_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    resets_at_iso: null,
    rate_limit_reached: false,
    reset_credits: 0,
    ts: new Date().toISOString(),
    age_minutes: 0,
    machine: null,
    ...overrides,
  };
}

function account(liveOther: AccountStateRow[]): RosterAccount {
  return {
    id: "codex2",
    vendor: "codex",
    plan: "plus",
    label: "codex2 (plus)",
    capabilities: {
      hasGaugeSeries: true,
      hasTokenDetail: true,
      hasCalibration: false,
      hasSecondWindow: true,
      reportsSide: "used",
      unit: "token",
    },
    has_gauge: false,
    active: true,
    vendor_account: null,
    vendor_account_source: null,
    first_seen: null,
    last_seen: null,
    cycle_count: 0,
    probe: null,
    live: state({}),
    live_other: liveOther,
    basis: "gauge",
    note: null,
    gauge_age_hours: 0,
    empty_reason: null,
    cycles: [],
    shadow: null,
    claude: null,
    gemini: null,
    grok: null,
    glm: null,
  };
}

function roster(row: RosterAccount): RosterResponse {
  return { window_minutes: 10_080, count: 1, accounts: [row] };
}

it("shows the Free 30-day percentage and reset in the headline", () => {
  const monthly = state({ plan_type: "free", slot: "primary", window_minutes: 43200, used_percent: 100, rate_limit_reached: true });
  const row = { ...account([]), plan: "free", live: monthly };
  const [card] = buildRoster(roster(row));
  expect(card).toMatchObject({ usedPercent: 100, spent: true, percentMeasured: true, second: null, windowLabel: "30d", tokensTotal: null });
  expect(card!.model?.series.window_minutes).toBe(43200);
});

describe("Claude committed meters while analytics prepare", () => {
  it("shows the real weekly and session percentages without inventing spend", () => {
    const now = Date.now();
    const reset = new Date(now + 7 * 24 * 3_600_000).toISOString();
    const row: RosterAccount = { ...account([]), id: "seat", vendor: "claude", basis: "declared", live: null };
    row.claude_meters = { weekly: { window_id: "week", counter: '["weekly_all","",10080]',
      window_start: new Date(now - 60_000).toISOString(), reset_at: reset, measured_at: new Date(now - 30_000).toISOString(),
      percent: 1, baseline_percent: 0, elapsed_percent: 0.01, remaining_hours: 168 },
      session: { window_id: "session", counter: '["session","",300]', window_start: new Date(now - 60_000).toISOString(),
        reset_at: new Date(now + 4 * 3_600_000).toISOString(), measured_at: new Date(now - 30_000).toISOString(),
        percent: 7, baseline_percent: 0, elapsed_percent: 20, remaining_hours: 4 } };
    for (const percent of [0, 1]) {
      row.claude_meters.weekly!.percent = percent;
      const [card] = buildRoster(roster(row), now);
      expect(card).toMatchObject({ usedPercent: percent, percentMeasured: true, resetIso: reset,
        remainingHours: 168, second: { usedPercent: 7, remainingHours: 4 },
        tokensTotal: null, tokensFresh: null, usd: null, calls: null, emptyReason: null });
    }
    row.claude_meters.weekly!.baseline_percent = null;
    expect(buildRoster(roster(row), now)[0]).toMatchObject({usedPercent:1,ppAhead:null,paceRatio:null});
  });
});

function indexedCycle(resetIso: string): ApiCycle {
  return {
    index: 1,
    label: "2026-08-26",
    anchor: Date.parse(resetIso) / 1000,
    resets_at_iso: resetIso,
    window_start_iso: new Date(Date.parse(resetIso) - 10_080 * 60_000).toISOString(),
    is_active: true,
    shadow: false,
    status: "on_track",
    start_ts: "2026-08-26T06:44:00.000Z",
    end_ts: "2026-08-27T10:54:35.000Z",
    work_from_ts: "2026-08-26T06:44:00.000Z",
    work_to_ts: resetIso,
    sample_count: 20,
    lag_fraction: 0,
    distinct_steps: 10,
    first_percent: 0,
    peak_percent: 17,
    end_percent: 17,
    hit_100: false,
    window_hours: 168,
    elapsed_hours: 28,
    observed_hours: 28,
    remaining_hours: 140,
    pace_percent_per_day: 14.57,
    projected_end_percent: 100,
    eta_100_iso: null,
    calls: 4,
    usd: 12,
    usd_per_percent: 0.7,
    usd_at_100_percent: null,
    tokens: { in: 100, cached_in: 80, cache_write: 0, out: 20, reasoning: 0, total: 120 },
    top_model: "gpt-5",
    source_models: [],
    model_usage: [],
    surface_usage: [],
    plan_types: ["plus"],
    limit_names: [],
    delta_peak_percent: null,
    delta_usd: null,
    delta_calls: null,
    pct_of_prev_peak: null,
    pct_of_prev_usd: null,
  };
}

describe("Codex second window", () => {
  it("uses the newer reading even when its reset precedes the index's active anchor", () => {
    const now = Date.now();
    const reset = new Date(now + 5 * 24 * 3_600_000).toISOString();
    const row = account([]);
    row.live = state({ used_percent: 57, resets_at_iso: reset, resets_at: Date.parse(reset) / 1000 });
    const matching = { ...indexedCycle(reset), is_active: false, peak_percent: 57 };
    const wrongActive = { ...indexedCycle(new Date(now + 6 * 24 * 3_600_000).toISOString()),
      index: 2, peak_percent: 1, end_ts: new Date(now - 24 * 3_600_000).toISOString() };
    row.cycles = [matching, wrongActive];
    const [card] = buildRoster(roster(row));
    expect(card!.usedPercent).toBe(57);
    expect(card!.resetIso).toBe(reset);
    expect(card!.model!.current!.usedPercent).toBe(57);
    expect(card!.model!.current!.raw.index).toBe(1);
    expect(card!.tokensTotal).toBe(120);
    expect(card!.model!.cycles.filter(cycle => cycle.isActive)).toHaveLength(1);
    expect(row.cycles[1]!.is_active).toBe(true);
  });

  it("keeps a newer indexed window when a delayed live reading targets an older anchor", () => {
    const now = Date.now();
    const row = account([]);
    row.live = state({ used_percent: 57, ts: new Date(now - 2 * 3_600_000).toISOString(),
      resets_at_iso: new Date(now + 5 * 24 * 3_600_000).toISOString() });
    row.cycles = [{ ...indexedCycle(new Date(now + 6 * 24 * 3_600_000).toISOString()),
      peak_percent: 1, end_ts: new Date(now - 3_600_000).toISOString() }];
    expect(buildRoster(roster(row))[0]!.usedPercent).toBe(1);
  });

  it("shows a plan-level 5h counter returned by a Plus account", () => {
    const fiveHour = state({ slot: "primary", window_minutes: 300, used_percent: 61 });
    const [card] = buildRoster(roster(account([fiveHour])));

    expect(card!.second?.label).toBe("5h");
    expect(card!.second?.usedPercent).toBe(61);
  });

  it("does not mistake a Spark 5h bucket for a second plan window", () => {
    const spark = state({
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      slot: "primary",
      window_minutes: 300,
      used_percent: 80,
    });
    const [card] = buildRoster(roster(account([spark])));

    expect(card!.second).toBeNull();
  });

  it("uses the fresh account window after reset instead of repeating the stale index percentage", () => {
    const now = Date.now();
    const row = account([
      state({
        slot: "primary",
        window_minutes: 300,
        used_percent: 0,
        resets_at: Math.floor(now / 1000) + 5 * 60 * 60,
      }),
    ]);
    row.live = state({
      used_percent: 0,
      resets_at: Math.floor(now / 1000) + 7 * 24 * 60 * 60,
      resets_at_iso: new Date(now + 7 * 24 * 3_600_000).toISOString(),
    });
    row.cycles = [indexedCycle(new Date(now + 5 * 24 * 3_600_000).toISOString())];

    const [card] = buildRoster(roster(row));

    expect(card!.usedPercent).toBe(0);
    expect(card!.note).toBe("just now");
    expect(card!.note).not.toContain("indeks");
    expect(card!.tokensTotal).toBeNull();
    expect(card!.model?.current?.usedPercent).toBe(0);
    expect(card!.model?.current?.resetIso).toBe(row.live.resets_at_iso);
    expect(card!.model?.current?.raw.sample_count).toBe(0);
    expect(card!.model?.closed.some((cycle) => cycle.usedPercent === 17)).toBe(true);

    const html = renderToStaticMarkup(
      createElement(SubscriptionCards, {
        cards: [card!],
        selected: "codex2",
        onSelect: () => {},
        columns: 1,
      }),
    );
    expect(html).not.toContain("indeks 17%");
    expect(html).toContain('data-second-window="true"');
    expect(html).toMatch(/data-second-window="true" class="sub-card-second"/);
    expect(html.match(/data-reset-time/g)).toHaveLength(2);
  });
});

describe("shared measured usage window", () => {
  it("shows Grok Billing as measured and keeps the local estimate diagnostic-only", () => {
    const now = Date.now();
    const start = new Date(now - 2 * 24 * 3_600_000).toISOString();
    const reset = new Date(now + 5 * 24 * 3_600_000).toISOString();
    const row: RosterAccount = {
      ...account([]),
      id: "grok",
      vendor: "grok",
      plan: "SuperGrok",
      label: "grok (SuperGrok)",
      basis: "gauge",
      live: null,
      live_other: [],
      grok: {
        window_hours: 168,
        anchored: false,
        since_ts: start,
        until_ts: reset,
        spend: {
          turns: 29,
          calls: 569,
          gross: 61_806_291,
          fresh: 6_656_211,
          cached: 55_150_080,
          out: 731_105,
          reasoning: 0,
          usd: 77.48,
        },
        models: [],
        first_ts: start,
        last_ts: new Date(now).toISOString(),
        age_hours: 0,
        usd_basis: "vendor",
        ticks_per_usd: 1_000_000_000,
        limit: {
          configured: true,
          plan: "SuperGrok",
          window_hours: 168,
          observations: [],
          calibration: null,
          current: {
            window_start: start,
            window_end: reset,
            anchored: true,
            anchor_ts: start,
            reset_in_hours: 120,
            spend: { turns: 29, calls: 569, gross: 61_806_291, fresh: 6_656_211, usd: 77.48 },
            percent_measured: 33,
            measured_at: new Date(now).toISOString(),
            measurement_age_minutes: 0,
            measurement_source: "grok_billing",
            percent_est: 16.8,
            remaining_usd: null,
            idle_hours: 0,
          },
          caveats: [],
        },
      },
    };

    const [card] = buildRoster(roster(row));
    expect(card?.usedPercent).toBe(33);
    expect(card?.percentMeasured).toBe(true);
    expect(card?.resetIso).toBe(reset);
    expect(card?.note).toContain("Billing");
    expect(card?.noteLong).toContain("Local cost would give 16.8%");
  });
});

function probe(over: Partial<RosterProbe>): RosterProbe {
  return {
    provider: "codex",
    subject: "codex2",
    state: "none",
    fresh_minutes: 15,
    reading: null,
    machines: [],
    ...over,
  };
}

describe("three probe states of the percent", () => {
  it("keeps a fresh percent and names the machine that read it", () => {
    const row = account([]);
    row.probe = probe({
      state: "fresh",
      reading: { ts: new Date().toISOString(), age_minutes: 4, machine: "EXAMPLE-MAIN" },
      machines: [
        { machine: "EXAMPLE-MAIN", last_ok_ts: new Date().toISOString(), last_error_ts: null, last_error: null },
      ],
    });

    const [card] = buildRoster(roster(row));
    expect(card!.usedPercent).toBe(24);
    expect(card!.probe?.state).toBe("fresh");
    expect(card!.probe?.line).toBe("4 min ago · EXAMPLE-MAIN");
    expect(card!.probe?.trail).toBe("");
  });

  it("says a legacy sample has no machine name instead of inventing one", () => {
    const row = account([]);
    row.probe = probe({
      state: "fresh",
      reading: { ts: new Date().toISOString(), age_minutes: 0.2, machine: null },
    });

    const [card] = buildRoster(roster(row));
    expect(card!.probe?.line).toBe("just now · unknown machine");
  });

  it("keeps a stale percent but says how old it is and which machine still works", () => {
    const now = Date.now();
    const row = account([]);
    row.probe = probe({
      state: "stale",
      reading: { ts: new Date(now - 900 * 60_000).toISOString(), age_minutes: 900, machine: "EXAMPLE-MAIN" },
      machines: [
        {
          machine: "EXAMPLE-MAIN",
          last_ok_ts: new Date(now - 900 * 60_000).toISOString(),
          last_error_ts: null,
          last_error: null,
        },
        {
          machine: "EXAMPLE-LAPTOP-A",
          last_ok_ts: null,
          last_error_ts: "2026-08-30T09:00:00.000Z",
          last_error: "auth.json missing",
        },
      ],
    });

    const [card] = buildRoster(roster(row), now);
    expect(card!.usedPercent).toBe(24);
    expect(card!.elapsedPercent).not.toBeNull();
    expect(card!.probe?.state).toBe("stale");
    expect(card!.probe?.line).toBe("last reading 15.0 h ago from EXAMPLE-MAIN");
    expect(card!.probe?.trail).toBe(
      "EXAMPLE-MAIN - last success 15.0 h ago; EXAMPLE-LAPTOP-A - probe error since 08/30 (auth.json missing)",
    );
  });

  it("drops the percent when no machine measures the subscription, and gives the reason instead", () => {
    const row = account([]);
    row.probe = probe({
      state: "none",
      machines: [
        {
          machine: "EXAMPLE-MAIN",
          last_ok_ts: null,
          last_error_ts: "2026-08-30T09:00:00.000Z",
          last_error: "auth.json missing",
        },
        {
          machine: "EXAMPLE-LAPTOP-A",
          last_ok_ts: null,
          last_error_ts: "2026-09-01T09:00:00.000Z",
          last_error: "pula Gemini nie jest dostępna na tej maszynie",
        },
      ],
    });

    const [card] = buildRoster(roster(row));
    expect(card!.usedPercent).toBeNull();
    expect(card!.percentMeasured).toBe(false);
    expect(card!.paceRatio).toBeNull();
    expect(card!.probe?.line).toBe("no machine is probing this subscription");
    expect(card!.probe?.trail).toBe(
      "EXAMPLE-MAIN - probe error since 08/30 (auth.json missing); EXAMPLE-LAPTOP-A - probe error since 09/01 (pula Gemini nie jest dostępna na tej maszynie)",
    );
    expect(card!.emptyReason).toBe("no machine is probing this subscription");
  });

  it("keeps a percent that the index carries on its own, even with every probe dead", () => {
    const now = Date.now();
    const row = account([]);
    row.live = null;
    row.cycles = [indexedCycle(new Date(now + 2 * 24 * 3_600_000).toISOString())];
    row.probe = probe({
      state: "none",
      machines: [
        { machine: "EXAMPLE-MAIN", last_ok_ts: null, last_error_ts: "2026-08-30T09:00:00.000Z", last_error: "boom" },
      ],
    });

    const [card] = buildRoster(roster(row), now);
    expect(card!.percentFromProbe).toBe(false);
    expect(card!.usedPercent).not.toBeNull();
    expect(card!.probe?.state).toBe("none");
  });
});

describe("Grok percent without a Billing reading", () => {
  function grokAccount(percentEst: number | null, turns: number): RosterAccount {
    const now = Date.now();
    const start = new Date(now - 2 * 24 * 3_600_000).toISOString();
    const reset = new Date(now + 5 * 24 * 3_600_000).toISOString();
    const spend = { turns, calls: turns * 4, gross: 100, fresh: 40, cached: 60, out: 10, reasoning: 0, usd: 77.48 };
    return {
      ...account([]),
      id: "grok",
      vendor: "grok",
      plan: "SuperGrok",
      label: "grok (SuperGrok)",
      basis: "spend",
      live: null,
      live_other: [],
      grok: {
        window_hours: 168,
        anchored: false,
        since_ts: start,
        until_ts: reset,
        spend,
        models: [],
        first_ts: start,
        last_ts: new Date(now).toISOString(),
        age_hours: 0,
        usd_basis: "vendor",
        ticks_per_usd: 1_000_000_000,
        limit: {
          configured: true,
          plan: "SuperGrok",
          window_hours: 168,
          observations: [],
          calibration: {
            source_ts: start,
            usd_per_point: 1.5,
            window_value_usd: 150,
            visible_share: 0.6,
            confidence: "medium",
            reason: "test",
          },
          current: {
            window_start: start,
            window_end: reset,
            anchored: true,
            anchor_ts: start,
            reset_in_hours: 120,
            spend: { turns, calls: turns * 4, gross: 100, fresh: 40, usd: 77.48 },
            percent_measured: null,
            measured_at: null,
            measurement_age_minutes: null,
            measurement_source: null,
            percent_est: percentEst,
            remaining_usd: null,
            idle_hours: 0,
          },
          caveats: [],
        },
      },
    };
  }

  it("shows an estimate as an estimate, never as the headline percent", () => {
    const [card] = buildRoster(roster(grokAccount(16.8, 29)));
    expect(card!.usedPercent).toBeNull();
    expect(card!.percentMeasured).toBe(false);
    expect(card!.estimatePercent).toBe(16.8);
    expect(card!.note).toContain("estimate");
    expect(card!.noteLong).toContain("ESTIMATE");
  });

  it("shows no percent at all when the window holds no indexed traffic", () => {
    const row = grokAccount(null, 0);
    row.probe = probe({
      provider: "grok",
      subject: "grok",
      state: "none",
      machines: [
        {
          machine: "EXAMPLE-LAPTOP-A",
          last_ok_ts: null,
          last_error_ts: "2026-09-01T09:00:00.000Z",
          last_error: "resolveAt zwrócił null",
        },
      ],
    });

    const [card] = buildRoster(roster(row));
    expect(card!.usedPercent).toBeNull();
    expect(card!.estimatePercent).toBeNull();
    expect(card!.note).toBe("no Billing reading or turns");
    expect(card!.probe?.line).toBe("no machine is probing this subscription");
    expect(card!.probe?.trail).toContain("EXAMPLE-LAPTOP-A - probe error since 09/01");
  });
});
