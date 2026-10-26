import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compact, usd } from "../lib/format";
import { BudgetCard, PaceCard, VersusCard, percentUnit } from "./WindowForecastPanel";

describe("window forecast panel", () => {
  it("values every unit from its per-point rate and marks incomplete pricing as a lower bound", () => {
    const html = renderToStaticMarkup(<BudgetCard active usedPercent={32} typicalEnd={88} linearEnd={174} units={[
      percentUnit("%", 32),
      { key: "tokens", label: "tokens", rate: 10_000_000, used: 320_000_000, partial: false, cap: 381_000_000, format: (v) => compact(v) },
      { key: "api", label: "API-eq", rate: 1.31, used: 43.18, partial: true, cap: null, format: usd },
    ]} />);
    expect(html).toContain("88% · 174%");
    expect(html).toContain("≈ 680M");
    expect(html).toContain("≈ 880M · ≈ 1.74B");
    expect(html).toContain("≈ 381M");
    expect(html).toContain("≥ $43.18");
    expect(html).toContain("≥ $115.28 · ≥ $227.94");
  });
  it("shows a closed window's result instead of forecasts", () => {
    const html = renderToStaticMarkup(<BudgetCard active={false} usedPercent={100} typicalEnd={null} linearEnd={null} units={[percentUnit("%", 100)]} />);
    expect(html).toContain("window result");
    expect(html).not.toContain("at reset");
  });
  it("states how much slower the pace must be to last until reset", () => {
    const html = renderToStaticMarkup(<PaceCard active sustainablePerDay={663_000_000} averagePerDay={1_390_000_000}
      burns={[{ label: "1h", perDay: 2_490_000_000 }]} />);
    expect(html).toContain("−52%");
    expect(html).toContain("2.49B/d");
    expect(html).toContain("1.39B/d");
  });
  it("marks an estimated used amount and prints rates in the caller's unit", () => {
    const budget = renderToStaticMarkup(<BudgetCard active usedPercent={49} typicalEnd={null} linearEnd={64} units={[
      { key: "tokens", label: "tokens", rate: 45_000_000, used: 2_210_000_000, estimated: true, partial: false, cap: null, format: (v) => compact(v) },
    ]} />);
    expect(budget).toContain("≈ 2.21B");
    const pace = renderToStaticMarkup(<PaceCard active sustainablePerDay={72} averagePerDay={24} burns={[]}
      format={(perDay) => `${perDay / 24} pp/h`} />);
    expect(pace).toContain("1 pp/h");
    expect(pace).toContain("lasts until reset: 3 pp/h");
    expect(pace).not.toContain("72/d");
  });
  it("colours the better side green for each comparison", () => {
    const html = renderToStaticMarkup(<VersusCard title="vs #67" empty="none" note="" rows={[
      { key: "limit", label: "Limit", delta: -38, text: "−38 pp", higherIsBetter: false },
      { key: "tokens", label: "Tokens / pp", delta: 184, text: "+184%", higherIsBetter: true },
      { key: "api", label: "API$ / pp", delta: -90, text: "−90%", higherIsBetter: true },
    ]} />);
    const colours = [...html.matchAll(/background:var\(--(ok|crit)\)/g)].map((m) => m[1]);
    expect(colours).toEqual(["ok", "ok", "crit"]);
  });
});
