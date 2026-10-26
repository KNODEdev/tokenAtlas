import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CycleView } from "../lib/cycle";
import { getLocale, setLanguage, type Language } from "../lib/i18n";
import { CycleHistoryTable, FullHistoryLink } from "./CycleHistoryTable";

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

function row(index: number, usedPercent: number, elapsedHours: number, isActive = false): CycleView {
  return {
    index, number: index, isActive, usedPercent, elapsedHours, windowHours: 168, color: "var(--accent)", resultLabel: "legacy label",
    startIso: "2026-09-01T00:00:00.000Z", endIso: "2026-09-08T00:00:00.000Z", resetIso: "2026-09-08T00:00:00.000Z",
    tokensTotal: 1_000, burnPerDay: null, topModel: "gpt-6", calibration: { allowanceTokens: null },
    raw: { plan_types: ["pro"], sample_count: 1, work_to_ts: "2026-09-08T00:00:00.000Z" },
  } as unknown as CycleView;
}

describe("shared window table", () => {
  it("renders the Overview's columns and the result that separates unused from an early reset", () => {
    const html = renderToStaticMarkup(
      <CycleHistoryTable cycles={[row(3, 10, 5, true), row(2, 37, 30), row(1, 37, 168)]} selectedIndex={3} medianPercent={50} onOpen={() => {}} onDetails={() => {}} />,
    );
    for (const header of ["cycle", "used", "vs 100% · median", "tokens / allow.", "Δ median", "average burn", "model", "window", "result"]) {
      expect(html).toContain(`>${header}<`);
    }
    expect(html).toContain(">current<");
    expect(html).toContain(">reset early<");
    expect(html).toContain(">unused<");
    expect(html).not.toContain("legacy label");
  });

  it("links the Overview to the whole archive in both languages", () => {
    expect(renderToStaticMarkup(<FullHistoryLink count={70} onOpen={() => {}} />)).toContain("Full history (70 windows) →");
    setLanguage("pl");
    expect(renderToStaticMarkup(<FullHistoryLink count={70} onOpen={() => {}} />)).toContain("Cała historia (70 okien) →");
  });
});
