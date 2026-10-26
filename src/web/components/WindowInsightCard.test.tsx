import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dayTime } from "../lib/format";
import type { RailWindow } from "../lib/windows";
import { WindowInsightCard } from "./WindowInsightCard";

function current(): RailWindow {
  return {
    key: "now",
    counterKey: "claude:weekly_all:all",
    counterLabel: "7d",
    label: "7d",
    dateLabel: "now",
    source: "probe",
    isCurrent: true,
    usedPercent: 51,
    percentBasis: "measured",
    elapsedPercent: 40,
    ppAhead: 11,
    windowHours: 168,
    startIso: "2026-08-28T00:00:00.000Z",
    resetIso: "2026-09-04T00:00:00.000Z",
    shape: [{ t: 0, pct: 0 }, { t: 40, pct: 51 }],
    regimeKey: "claude:weekly_all:all:pro:168h",
    sampledAtIso: "2026-09-03T11:55:00.000Z",
    sampleMachine: "EXAMPLE-MAIN",
    trafficByMachine: [
      { machine: "EXAMPLE-MAIN", amount: 120_000 },
      { machine: "EXAMPLE-LAPTOP-A", amount: 30_000 },
    ],
    tokensTotal: null,
    usd: null,
    note: null,
    scope: null,
    sublimits: [{
      counterKey: "claude:weekly_scoped:Fable",
      label: "Fable",
      usedPercent: 43,
      percentBasis: "measured",
      shape: [{ t: 0, pct: 0 }, { t: 40, pct: 43 }],
      regimeKey: "claude:weekly_scoped:Fable:pro:168h",
      sampledAtIso: "2026-09-03T11:55:00.000Z",
      sampleMachine: "EXAMPLE-LAPTOP-A",
      tokensTotal: null,
      usd: null,
      note: null,
    }],
  };
}

function closed(key: string, at40: number, end: number): RailWindow {
  const row = current();
  return {
    ...row,
    key,
    dateLabel: key,
    isCurrent: false,
    usedPercent: end,
    elapsedPercent: 100,
    resetIso: key === "old-1" ? "2026-08-21T00:00:00.000Z" : "2026-08-14T00:00:00.000Z",
    shape: [{ t: 0, pct: 0 }, { t: 40, pct: at40 }, { t: 100, pct: end }],
    sampledAtIso: null,
    sampleMachine: null,
    sublimits: [],
  };
}

describe("WindowInsightCard", () => {
  it("shows current, typical forecast, provenance and a separate Fable sublimit", () => {
    const html = renderToStaticMarkup(createElement(WindowInsightCard, {
      windows: [current(), closed("old-1", 36, 80), closed("old-2", 40, 84)],
      account: "claude-main",
      nowMs: Date.parse("2026-09-03T12:00:00.000Z"),
    }));
    expect(html).toContain("forecast ≈95%");
    expect(html).toContain("typical ≈38% now · +13 pp");
    expect(html).toContain("EXAMPLE-MAIN");
    expect(html).toContain("indexed token share:");
    expect(html).toContain('role="img"');
    expect(html).toContain("Share of indexed tokens by machine. EXAMPLE-MAIN: 80%, EXAMPLE-LAPTOP-A: 20%");
    expect(html).toContain("EXAMPLE-MAIN 80% (120k)");
    expect(html).toContain("EXAMPLE-LAPTOP-A 20% (30k)");
    expect(html).toContain("Fable");
    expect(html).toContain("sub-limit");
    expect(html).toContain("typical course: 0/2 windows");
  });

  it("marks a counterfactual current percentage as an estimate, never as a reading", () => {
    const estimated = {
      ...current(),
      source: "declared" as const,
      percentBasis: "counterfactual" as const,
      sampledAtIso: null,
      sublimits: [],
    };
    const html = renderToStaticMarkup(createElement(WindowInsightCard, {
      windows: [estimated, closed("old-1", 36, 80), closed("old-2", 40, 84)],
      account: "claude-main",
      nowMs: Date.parse("2026-09-03T12:00:00.000Z"),
    }));

    expect(html).toContain("≈51%");
    expect(html).toContain("estimate");
    expect(html).toContain("computed percentage");
    expect(html).not.toContain("% odczyt");
    expect(html).not.toContain("forecast");
    expect(html).not.toContain("typically ≈");
  });

  it("shows the selected closed window and suppresses current-only forecasts", () => {
    const selectedEndIso = "2026-08-21T02:05:00.000Z";
    const html = renderToStaticMarkup(createElement(WindowInsightCard, {
      windows: [current(), closed("old-1", 36, 80), closed("old-2", 40, 84)],
      account: "claude-main",
      selectedKey: "old-1",
      selectedEndIso,
      nowMs: Date.parse("2026-09-03T12:00:00.000Z"),
    }));

    expect(html).toContain("Selected subscription window");
    expect(html).toContain("80%");
    expect(html).toContain("selected closed window");
    expect(html).toContain(`closed · ${dayTime(selectedEndIso)}`);
    expect(html).toContain("No forecast is applied to a closed window");
    expect(html).not.toContain("forecast ≈");
    expect(html).not.toContain("51%");
  });

  it("lists the account meters without windows and explains a plan change that restarted the week", () => {
    const week: RailWindow = {
      ...current(),
      counterSegment: { startDrop: { before: 88, after: 0 }, endDrop: null },
      accountMeters: {
        read_at: "2026-09-03T11:55:00.000Z",
        meters: [
          { key: "iguana_necktie", utilization_percent: 0, resets_at: "2026-11-05T07:59:00.000Z", limit_dollars: 250, used_dollars: 0, remaining_dollars: 250 },
          { key: "nimbus_quill", utilization_percent: 0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null },
        ],
        extra_usage: { enabled: false, user_disabled: true, spent_minor: 0, currency: "USD", exponent: 2 },
      },
    };
    const html = renderToStaticMarkup(createElement(WindowInsightCard, {
      windows: [week], account: "claude-main", nowMs: Date.parse("2026-09-03T12:00:00.000Z"),
    }));
    expect(html).toContain("Account counters");
    expect(html).toContain("segment since the plan change");
    expect(html).toContain("the weekly counter fell from 88% to 0% without moving its reset");
    expect(html).toContain("Dollar limit");
    expect(html).toContain("iguana_necktie · meaning unconfirmed");
    expect(html).toContain("/ 250 $");
    expect(html).toContain("nimbus_quill · meaning unconfirmed");
    expect(html).toContain("no reset reported");
    expect(html).toContain("Extra usage");
    expect(html).toContain("turned off by the user");
  });

  it("keeps the generic counter card for other vendors", () => {
    const codex = { ...current(), counterKey: "codex:codex:168h", regimeKey: "codex:codex:168h:pro", sublimits: [] };
    const html = renderToStaticMarkup(createElement(WindowInsightCard, {
      windows: [codex], account: "codex1", nowMs: Date.parse("2026-09-03T12:00:00.000Z"),
    }));
    expect(html).not.toContain("Account counters");
    expect(html).toContain("building history · 0/2");
  });
});
