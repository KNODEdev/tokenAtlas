import { expect, test } from "bun:test";
import { contextBand, disjointPromptInput, inContextBand, selectContextRates } from "./context-tier";

test("the band is strictly above the threshold and unknown without a valid prompt size", () => {
  const tier = { above_input_tokens: 100, rates: { r: 5 } };
  expect(contextBand(undefined, 1e9)).toBeNull();
  expect(contextBand(tier, 100)).toBe("base");
  expect(contextBand(tier, 101)).toBe("long");
  for (const bad of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(contextBand(tier, bad)).toBe("unknown");
  expect([inContextBand("normal", 100, 100), inContextBand("long", 100, 100), inContextBand("long", 100, 101), inContextBand("long", undefined, 0)])
    .toEqual([true, false, true, true]);
  expect(disjointPromptInput([1, 2, 3])).toBe(6);
  expect(disjointPromptInput([1, null])).toBeNull();
});

test("a variant without its own tier is priced only in the base band", () => {
  const tier = { above_input_tokens: 100, rates: { r: 5 } };
  expect(selectContextRates({ r: 1 }, tier, tier, 101)).toEqual({ rates: { r: 5 }, band: "long", threshold: 100 });
  expect(selectContextRates({ r: 2 }, undefined, tier, 100).rates).toEqual({ r: 2 });
  expect(selectContextRates({ r: 2 }, undefined, tier, 101).rates).toBeUndefined();
  expect(selectContextRates({ r: 2 }, undefined, tier, undefined).rates).toBeUndefined();
  expect(selectContextRates({ r: 2 }, undefined, undefined, undefined)).toEqual({ rates: { r: 2 }, band: null, threshold: undefined });
});
