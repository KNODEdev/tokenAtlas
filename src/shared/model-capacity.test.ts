import { expect, test } from "bun:test";
import { modelCapacitySamples, modelCapacitySpread, type ModelCapacityReading, type ModelCapacityUsage } from "./model-capacity";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
const use = (model: string | null, tokens: number, extra: Partial<ModelCapacityUsage> = {}): ModelCapacityUsage => ({
  model, tokens, events: 1, api_usd: tokens / 1e6, unpriced_events: 0, unknown_mode_tokens: 0, fast_tokens: 0, ...extra });
const reading = (minute: number, percent: number, models: ModelCapacityUsage[] = []): ModelCapacityReading => ({ ts: at(minute), percent, models });

test("real partial boundaries produce disjoint 20pp blocks and retain their small tail", () => {
  const result = modelCapacitySamples([reading(0, 12, [use("m", 999)]), reading(1, 22, [use("m", 100)]),
    reading(2, 32, [use("m", 100)]), reading(3, 52, [use("m", 300)]), reading(4, 57, [use("m", 50)])]);
  expect(result.samples.map(s => [s.observed_pp, s.tokens])).toEqual([[20, 200], [20, 300], [5, 50]]);
  expect(result.samples[0]!.from).toBe(at(0));
  expect(result.samples[0]!.through).toBe(result.samples[1]!.from);
  expect(result.single_model_intervals).toBe(4);
});

test("flat-meter traffic belongs to its whole sample rather than disappearing", () => {
  const result = modelCapacitySamples([reading(0, 20), reading(1, 20, [use("m", 100)]),
    reading(2, 30, [use("m", 200)]), reading(3, 40, [use("m", 300)])]);
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]).toMatchObject({ tokens: 600, observed_pp: 20 });
});

test("a recurring model in mixed traffic cannot masquerade as a single-model span", () => {
  const result = modelCapacitySamples([reading(0, 0), reading(1, 10, [use("a", 100)]),
    reading(2, 20, [use("a", 100), use("b", 10)]), reading(3, 30, [use("a", 100)])]);
  expect(result.samples.map(s => [s.model, s.observed_pp])).toEqual([["a", 10], ["a", 10]]);
  expect(result.models).toEqual(["a", "b"]);
});

test("the first 100% ends the sample; saturated traffic is never used", () => {
  const result = modelCapacitySamples([reading(0, 70), reading(1, 90, [use("a", 100)]),
    reading(2, 100, [use("a", 200)]), reading(3, 100, [use("b", 9999)])]);
  expect(result.samples.map(s => [s.tokens, s.reaches_100])).toEqual([[100, false], [200, true]]);
  expect(result.models).toEqual(["a"]);
});

test("drops, missing traffic, unknown models and conflicting instants break a run", () => {
  const result = modelCapacitySamples([reading(0, 20), reading(1, 30, [use("a", 100)]),
    reading(2, 10, [use("a", 99)]), reading(3, 20, [use("a", 100)]), reading(4, 30),
    reading(5, 40, [use(null, 100)]), reading(6, 50, [use("a", 100)]), reading(6, 60, [use("a", 100)])]);
  expect(result.samples.map(s => s.observed_pp)).toEqual([10, 10, 10]);
  expect(result.samples.reduce((n,s)=>n+s.tokens,0)).toBe(300);
});

test("synthetic zero traffic does not change purity; missing prices and modes remain explicit", () => {
  const result = modelCapacitySamples([reading(0, 0), reading(1, 20, [use("a", 100, { unpriced_events: 1, unknown_mode_tokens: 100 }),
    use("<synthetic>", 0, { api_usd: 0 })])]);
  expect(result.samples[0]).toMatchObject({ unpriced_events: 1, unknown_mode_tokens: 100 });
  expect(result.models).toEqual(["a"]);
});

test("quartiles use unrounded sample values, with explicit absence", () => {
  expect(modelCapacitySpread([])).toBeNull();
  expect(modelCapacitySpread([100, 300, 200, 400])).toEqual({ median: 250, p25: 175, p75: 325 });
  expect(modelCapacitySpread([1/3])).toEqual({ median: 1/3, p25: 1/3, p75: 1/3 });
});

test("a zero-token real call of another model still breaks purity", () => {
  const result=modelCapacitySamples([reading(0,0),reading(1,20,[use('a',100),use('b',0)])]);
  expect(result.samples).toEqual([]);expect(result.models).toEqual(['a','b']);
});

test("a repeated identical reading preserves a block without duplicating traffic", () => {
  const result=modelCapacitySamples([reading(0,0),reading(1,10,[use('a',100)]),reading(1,10),reading(2,20,[use('a',100)])]);
  expect(result.samples.map(s=>[s.observed_pp,s.tokens])).toEqual([[20,200]]);
});
