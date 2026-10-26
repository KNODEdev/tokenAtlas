import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexAccountingRule, TimelineMarker, TimelinePriceTransition } from "../../shared/codex-accounting";
import { getLocale, setLanguage, type Language } from "../lib/i18n";
import { CapacityMilestones, markerKindLabel, markerUtcLabel } from "./CapacityAnnotations";
import { ConfiguredPriceDetails } from "./ConfiguredPriceDetails";

function rule(overrides: Partial<CodexAccountingRule> = {}): CodexAccountingRule {
  return {
    id: "manual-rule",
    model: "gpt-zero",
    billing_basis: "chatgpt_credits",
    speed: "standard",
    valid_from: "2026-09-01",
    verified_at: "2026-09-12",
    sources: ["https://manual.example/rates"],
    confidence: "user",
    rates: { in_uncached: 1, in_cache_read: 0.1, out_total: 6 },
    multiplier: 1,
    ...overrides,
  };
}

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

test("renders configured transitions with zero and missing rates, long context, and manual evidence", () => {
  const pricing: TimelinePriceTransition[] = [
    {
      model: "gpt-zero",
      basis: "chatgpt_credits",
      speed: "standard",
      before: rule({
        rates: { in_uncached: 0, in_cache_read: 0, out_total: 0 },
        long_context: { above_input_tokens: 128_000, rates: { in_uncached: 0, in_cache_read: 0.2, out_total: 3 } },
      }),
      after: null,
    },
    {
      model: "gpt-manual",
      basis: "api_equivalent_usd",
      speed: "fast",
      before: null,
      after: rule({
        model: "gpt-manual",
        rates: { in_uncached: 2, in_cache_read: 0.5, out_total: 8 },
        included_usage: "proportional",
      }),
    },
  ];
  const html = renderToStaticMarkup(<ConfiguredPriceDetails pricing={pricing} />);
  expect(html).toContain("0 / 0 / 0");
  expect(html).toContain("not configured");
  expect(html).toContain("Long context");
  expect(html).toContain("128,000 input tokens");
  expect(html).toContain("user declaration");
  expect(html).toContain('href="https://manual.example/rates"');
  expect(html).toContain("declaration: proportional");
  expect(html).toContain("does not establish a fixed subscription credit budget");
});

test("makes generic configured pricing milestones expandable and dates explicit", () => {
  const pricing: TimelinePriceTransition[] = [{
    model: "gpt-zero",
    basis: "chatgpt_credits",
    speed: "standard",
    before: rule(),
    after: rule({ valid_from: "2026-09-12", rates: { in_uncached: 2, in_cache_read: 0.2, out_total: 12 } }),
  }];
  const marker: TimelineMarker = {
    id: "price:configured:gpt-zero:2026-09-12",
    day: "2026-09-12",
    label: "gpt-zero · configured price change",
    note: "manual test",
    color: "warn",
    visible: true,
    pricing,
  };
  expect(markerKindLabel(marker)).toContain("configured API price change · subscription impact unverified");
  expect(markerUtcLabel(marker)).toContain("00:00 UTC");
  expect(markerUtcLabel(marker)).toContain("configured date boundary");
  const html = renderToStaticMarkup(<CapacityMilestones markers={[marker]} />);
  expect(html).toContain("<details");
  expect(html).toContain("Configured app pricing");
  expect(html).toContain("gpt-zero");
});
