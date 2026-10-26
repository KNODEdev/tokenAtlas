import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RailWindow } from "../lib/windows";
import { getLocale, setLanguage, type Language } from "../lib/i18n";
import { WindowCompare } from "./WindowCompare";

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

function row(
  key: string,
  isCurrent: boolean,
  percentBasis: RailWindow["percentBasis"] = "measured"
): RailWindow {
  return {
    key,
    counterKey: "claude:weekly_all:all",
    counterLabel: "7d",
    label: "7d",
    dateLabel: key,
    source: percentBasis === "counterfactual" ? "declared" : "probe",
    isCurrent,
    usedPercent: isCurrent ? 50 : key === "old-1" ? 80 : 90,
    percentBasis,
    elapsedPercent: isCurrent ? 40 : 100,
    ppAhead: null,
    windowHours: 168,
    startIso: isCurrent ? "2026-08-28T00:00:00.000Z" : "2026-08-21T00:00:00.000Z",
    resetIso: isCurrent ? "2026-09-04T00:00:00.000Z" : key === "old-1" ? "2026-08-28T00:00:00.000Z" : "2026-08-21T00:00:00.000Z",
    shape: [{ t: 0, pct: 0 }, { t: 40, pct: isCurrent ? 50 : 35 }, { t: 100, pct: isCurrent ? 50 : 80 }],
    regimeKey: "claude:weekly_all:all:pro:168h",
    sampledAtIso: isCurrent ? new Date().toISOString() : null,
    sampleMachine: isCurrent ? "EXAMPLE-MAIN" : null,
    tokensTotal: null,
    usd: null,
    note: null,
    scope: null,
    sublimits: [],
  };
}

describe("WindowCompare", () => {
  it("draws only windows with real readings and leaves counterfactual rows out", () => {
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("now", true), row("old-1", false), row("cost-only", false, "counterfactual")],
    }));
    expect(html).toContain("Usage since window start");
    expect(html).toContain("<polyline");
    expect(html).toContain("At the same moment");
    expect(html).not.toContain("cost-only");
    expect(html).not.toContain("other plan ·");
  });

  it("greys a week from an earlier plan and keeps it out of the typical course (decision 13)", () => {
    const earlier = { ...row("old-2", false), regimeKey: "claude:weekly_all:all:max-5x:168h" };
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("now", true), earlier],
    }));
    expect(html).toContain("<polyline");
    expect(html).toContain("other plan · ");
    expect(html).toContain("Building history: 0/2");
    expect(html).not.toContain("typically");
  });

  it("builds a typical course from two windows of the same plan", () => {
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("now", true), row("old-1", false), { ...row("old-2", false), startIso: "2026-08-14T00:00:00.000Z", resetIso: "2026-08-21T00:00:00.000Z" }],
    }));
    expect(html).toContain("typically");
    expect(html).toContain("median of 2 windows");
    expect(html).toContain("(forecast)");
  });

  it("marks a counterfactual current percentage as calculated and forecasts nothing", () => {
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("now", true, "counterfactual"), row("old-1", false), row("old-2", false)],
    }));
    expect(html).toContain("≈50%");
    expect(html).not.toContain("forecast of the current window");
  });

  it("compares closed windows when no window is in progress", () => {
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("old-1", false), row("old-2", false)],
    }));
    expect(html).toContain("Compared windows");
    expect(html).not.toContain("now ·");
  });

  it("puts multiple counter controls in a labelled keyboard-focusable scroll region", () => {
    const second = [row("other-now", true), row("other-old", false)].map((item) => ({
      ...item,
      counterKey: "claude:five_hour:all:all",
      counterLabel: "5h",
      label: "5h",
      windowHours: 5,
      regimeKey: "claude:five_hour:all:all:pro:5h",
    }));
    const html = renderToStaticMarkup(createElement(WindowCompare, {
      account: "claude-main",
      windows: [row("now", true), row("old-1", false), ...second],
    }));

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Comparison counter selection"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Session 5h<");
    expect(html).toContain(">Week 7d<");
  });
});
