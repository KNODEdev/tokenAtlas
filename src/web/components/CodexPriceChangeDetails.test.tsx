import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import rateCards from "../../../rate-cards.json";
import { priceCodexEvent, prepareCodexPricing, resolveCodexAccountingConfig } from "../../server/codex-accounting-pricing";
import type { RateCard } from "../../server/pricing";
import { CODEX_PRICE_CHANGES, priceChangeFor, uniformPriceRatio } from "../../shared/codex-price-changes";
import { CapacityMilestones, markerKindLabel, markerUtcLabel } from "./CapacityAnnotations";
import { CodexPriceChangeDetails } from "./CodexPriceChangeDetails";
import { setLanguage } from "../lib/i18n";

test("utility-model marker vectors match dated accounting on both sides of the reduction", () => {
  const config = prepareCodexPricing(resolveCodexAccountingConfig(rateCards as RateCard));
  const change = CODEX_PRICE_CHANGES[0]!;
  for (const model of change.models) {
    for (const before of [true, false]) {
      const event = { model: model.name.toLowerCase().replace(" ", "-"), speed: "standard", ts: before ? "2026-07-29T12:00:00Z" : "2026-07-30T12:00:00Z", in_tok: 100_000, cached_in: 80_000, cache_write: 0, out_tok: 10_000 };
      for (const basis of ["api_equivalent_usd", "chatgpt_credits"] as const) {
        const vector = basis === "api_equivalent_usd" ? before ? model.apiBefore : model.apiAfter : before ? model.creditsBefore! : model.creditsAfter;
        const expected = .02 * vector.in_uncached + .08 * vector.in_cache_read + .01 * vector.out_total;
        expect(priceCodexEvent(config, event, basis).amount).toBeCloseTo(expected, 12);
      }
    }
    const apiRatio = uniformPriceRatio(model.apiBefore, model.apiAfter)!;
    const creditRatio = uniformPriceRatio(model.creditsBefore!, model.creditsAfter)!;
    expect(apiRatio / creditRatio).toBeCloseTo(1, 12);
    expect(1 / creditRatio).toBeCloseTo(model.name.endsWith("Luna") ? 5 : 1.25, 12);
  }
});

test("Sol has no certified old credit rate or single API reduction multiplier", () => {
  const sol = CODEX_PRICE_CHANGES[1]!;
  expect(sol.models[0]!.creditsBefore).toBeNull();
  expect(uniformPriceRatio(sol.models[0]!.apiBefore, sol.models[0]!.apiAfter)).toBeNull();
  setLanguage("en");
  const html = renderToStaticMarkup(<CodexPriceChangeDetails change={sol} />);
  expect(html).toContain("Not established");
  expect(html).toContain("125 / 12.5 / 750");
  expect(html).toContain("hypothesis, not a historical tariff");
  expect(html).toContain("Nominal Pro budget: unverified");
  expect(html).toContain('href="https://learn.chatgpt.com/docs/pricing#token-rates"');
});

test("price milestones expose subscription status and dated sources without hiding them in a tooltip", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<CapacityMilestones markers={CODEX_PRICE_CHANGES.map(change => change.marker)} />);
  expect(html).toContain("included-usage impact declared");
  expect(html).toContain("subscription impact unverified");
  expect(html).toContain("5× as many identical tokens, conditionally");
  expect(html).toContain("1.25× as many identical tokens, conditionally");
  expect(html).toContain("time not published");
  expect(html.match(/<details /g)).toHaveLength(2);
  const moved = { ...CODEX_PRICE_CHANGES[0]!.marker, day: "2026-07-31" };
  expect(priceChangeFor(moved)).toBeUndefined();
  expect(markerKindLabel(moved)).toBe("event");
  expect(markerUtcLabel(CODEX_PRICE_CHANGES[0]!.marker)).not.toContain("00:00");
});
