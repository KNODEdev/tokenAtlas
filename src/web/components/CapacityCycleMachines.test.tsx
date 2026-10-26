import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapacityCycleSource } from "../../shared/capacity-cycle";
import { CapacityCycleMachines, cycleMachines, machineShares, sourceProfile } from "./CapacityCycleMachines";

const source = (name: string, machine: string | null, api: number | null, tokens: number): CapacityCycleSource => ({
  name, machine, first: "2026-10-11T05:25:04.000Z", last: "2026-10-12T10:38:00.000Z", events: 10, tokens, input: tokens, cached: 0, output: 0,
  fast_tokens: 0, unknown_tokens: 0, priced_tokens: api === null ? 0 : tokens, unpriced_events: api === null ? 10 : 0,
  api_standard: api ?? 0, credits_low: 0, credits_high: 0,
});
const SOURCES = [
  source("H:/archive/codex/EXAMPLE-MAIN-sample_a", "EXAMPLE-MAIN", 160, 800),
  source("H:/archive/codex/EXAMPLE-LAPTOP-A-sample_a", "EXAMPLE-LAPTOP-A", 30, 150),
  source("H:/archive/codex/EXAMPLE-LAPTOP-A-sample_a-codex-mr", "EXAMPLE-LAPTOP-A", 10, 50),
  source("H:/archive/projectAsus", null, null, 400),
];

test("computer totals and profile shares use each source's complete context split", () => {
  const first = { ...SOURCES[0]!, context_api_base: 160, context_api_extra: 40, context_priced_tokens: 800 };
  const sources = [first, { ...SOURCES[1]!, context_api_base: 30, context_api_extra: 10, context_priced_tokens: 1 }];
  const render = (contextImpact: boolean) => renderToStaticMarkup(<CapacityCycleMachines sources={sources} creditsAvailable contextImpact={contextImpact} />);
  const off = render(false), on = render(true);
  expect(off).toContain("EXAMPLE-MAIN · $160.00");
  expect(on).toContain("EXAMPLE-MAIN · $200.00");
  expect(on).toContain("EXAMPLE-LAPTOP-A · $30.00");
  expect(render(false)).toBe(off);
  expect(first.api_standard).toBe(160);
});

describe("cycle computers", () => {
  test("sources group by computer, largest traffic first and the unknown computer last", () => {
    const machines = cycleMachines(SOURCES);
    expect(machines.map(m => [m.machine, m.usage.tokens, m.usage.api_standard, m.sources.length])).toEqual([
      ["EXAMPLE-MAIN", 800, 160, 1], ["EXAMPLE-LAPTOP-A", 200, 40, 2], [null, 400, 0, 1]]);
  });
  test("money shares cover the priced part only; an unpriced computer has no share rather than zero", () => {
    const shares = machineShares(cycleMachines(SOURCES), "api_standard");
    expect(shares.get("EXAMPLE-MAIN")).toBeCloseTo(0.8);
    expect(shares.get("EXAMPLE-LAPTOP-A")).toBeCloseTo(0.2);
    expect(shares.get(null)).toBeNull();
    expect(machineShares(cycleMachines(SOURCES), "tokens").get(null)).toBeCloseTo(400 / 1400);
  });
  test("a profile is the folder after the computer's name; the computer's own folder is its main profile", () => {
    expect(sourceProfile(SOURCES[2]!)).toBe("sample_a-codex-mr");
    expect(sourceProfile({ name: "claude/example-main", machine: "EXAMPLE-MAIN" })).toBeNull();
    expect(sourceProfile(SOURCES[3]!)).toBe("projectAsus");
  });
  test("the tab names each computer with its share and lists profiles under it", () => {
    const html = renderToStaticMarkup(<CapacityCycleMachines sources={SOURCES} creditsAvailable />);
    expect(html).toContain("EXAMPLE-LAPTOP-A");
    expect(html).toContain("sample_a-codex-mr");
    expect(html).toContain("80%");
    expect(html).toContain("20%");
    expect(renderToStaticMarkup(<CapacityCycleMachines sources={[]} creditsAvailable={false} />)).toContain("No recorded traffic in this cycle.");
  });
});
