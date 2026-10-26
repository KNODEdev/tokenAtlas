import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RailWindow } from "../lib/windows";
import { getLocale, setLanguage, type Language } from "../lib/i18n";
import { WindowHistory } from "./WindowHistory";

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

function weekly(key: string, current: boolean): RailWindow {
  return {
    key,
    counterKey: "claude:weekly_all:all",
    counterLabel: "7d",
    label: "7d",
    dateLabel: key,
    source: "probe",
    isCurrent: current,
    usedPercent: current ? 50 : 80,
    percentBasis: "measured",
    elapsedPercent: current ? 40 : 100,
    ppAhead: null,
    windowHours: 168,
    startIso: current ? "2026-08-28T00:00:00.000Z" : "2026-08-21T00:00:00.000Z",
    resetIso: current ? "2026-09-04T00:00:00.000Z" : "2026-08-28T00:00:00.000Z",
    shape: [{ t: 0, pct: 0 }, { t: 40, pct: current ? 50 : 35 }, { t: 100, pct: current ? 50 : 80 }],
    regimeKey: "claude:weekly_all:all:pro:168h",
    sampledAtIso: current ? "2026-09-03T12:00:00.000Z" : null,
    sampleMachine: current ? "EXAMPLE-MAIN" : null,
    tokensTotal: 1_000,
    usd: 2,
    note: null,
    scope: null,
    sublimits: [{
      counterKey: "claude:weekly_scoped:Fable",
      label: "Fable",
      usedPercent: current ? 40 : 70,
      percentBasis: "measured",
      shape: [{ t: 0, pct: 0 }, { t: 40, pct: current ? 40 : 30 }, { t: 100, pct: current ? 40 : 70 }],
      regimeKey: "claude:weekly_scoped:Fable:pro:168h",
      sampledAtIso: current ? "2026-09-03T12:00:00.000Z" : null,
      sampleMachine: current ? "EXAMPLE-LAPTOP-A" : null,
      tokensTotal: 600,
      usd: 1.2,
      note: null,
    }],
  };
}

describe("WindowHistory", () => {
  it("exposes Fable as its own selectable history counter", () => {
    const html = renderToStaticMarkup(createElement(WindowHistory, {
      windows: [weekly("now", true), weekly("old", false)],
      account: "claude-main",
      activeKey: null,
      onSelect: () => {},
    }));
    expect(html).toContain(">Week 7d<");
    expect(html).toContain(">↳ Fable 7d<");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="History counter selection"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("shows read and reconstructed windows of one meter as one counter with a basis split", () => {
    const cadence: RailWindow = {
      ...weekly("cadence", false), counterKey: "claude:weekly_all:none", source: "declared", percentBasis: null, usedPercent: null, shape: null,
      startIso: "2026-08-14T00:00:00.000Z", resetIso: "2026-08-21T00:00:00.000Z", sublimits: [],
    };
    const html = renderToStaticMarkup(createElement(WindowHistory, {
      windows: [weekly("now", true), weekly("old", false), cadence],
      account: "claude-main",
      activeKey: null,
      onSelect: () => {},
    }));
    expect(html.match(/>Week 7d</g)?.length).toBe(1);
    expect(html).toContain("Weekly windows");
    expect(html).toContain("2 from a % reading · 1 reconstructed from the cadence");
    expect(html).toContain("building history · 1/2 comparable windows");
    expect(html).toContain("reconstructed from the cadence, no %");
  });

  it("folds the table to the newest ten windows", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...weekly(`w${i}`, i === 0),
      startIso: new Date(Date.UTC(2026, 8, 20) - i * 7 * 86_400_000).toISOString(),
      resetIso: new Date(Date.UTC(2026, 8, 27) - i * 7 * 86_400_000).toISOString(),
    }));
    const html = renderToStaticMarkup(createElement(WindowHistory, { windows: many, account: "claude-main", activeKey: null, onSelect: () => {} }));
    expect(html).toContain("show all 12");
  });
});
