import { expect, test } from "bun:test";
import { accountingOptions } from "./codex-accounting";
import { priceCodexEvent, type CodexAccountingConfig } from "./codex-accounting-pricing";
import { addReferenceValuation } from "./subscription-revaluation";
import { emptyWindowUsage } from "./subscription-window-comparison";
import { codexWindowsFixture } from "./window-usage.fixture";
import type { CalibrationEvent, CodexProbe } from "./codex-calibration";
import { publishedCodexComparisonFixture } from "./codex-ledger.fixture";

const rates = (n: number) => ({ in_uncached: n, in_cache_read: n, out_total: n });
const config: CodexAccountingConfig = { version: 1, rules: [
  { id: "old", model: "test", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-01-01", valid_until: "2026-08-01", verified_at: "2026-01-01", confidence: "user", sources: ["https://example.test/synthetic"], multiplier: 1, rates: rates(2) },
  { id: "new", model: "test", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-08-01", valid_until: "2026-10-01", verified_at: "2026-08-01", confidence: "user", sources: ["https://example.test/synthetic"], multiplier: 1, rates: rates(1), long_context: { above_input_tokens: 200000, rates: rates(3) } },
] };
const event: CalibrationEvent = { account: "a", home: "pc", model: "test", speed: "fast", ts: "2026-07-01T01:00:00Z", in_tok: 100000, cached_in: 0, out_tok: 0, cache_write: 0 };
const probes: CodexProbe[] = [0, 2].map(hour => ({ subject: "a", ts: `2026-07-01T0${hour}:00:00Z`, kind: "weekly", plan: "pro", window_minutes: 10080, used_percent: hour * 25, resets_at: "2026-07-08T00:00:00Z" }));

test("reference date validates exact calendar days", () => {
  const params = new URLSearchParams({ since: "2026-07-01", until: "2026-07-01", reference_day: "2026-02-30" });
  expect(() => accountingOptions(params)).toThrow("reference_day");
  params.set("reference_day", "2026-08-01");
  expect(accountingOptions(params).reference_day).toBe("2026-08-01");
});

test("fixed-date pricing keeps original timestamps for matching and does not require credit rates", () => {
  const windows = codexWindowsFixture(config, publishedCodexComparisonFixture(config,[event],"2026-08-01"), probes, 10080, "2026-08-01");
  expect(windows).toHaveLength(1);
  expect(windows[0]!.usage).toMatchObject({ paired_historical_api: 0.2, paired_reference_api: 0.1, revaluation_events: 1, revaluation_tokens: 100000, fast_tokens: 100000 });
  expect(windows[0]!.models[0]!.paired_reference_api).toBe(0.1);
  expect(windows[0]!.sources[0]!.revaluation_events).toBe(1);
  expect(event.ts).toBe("2026-07-01T01:00:00Z");
  expect(event.speed).toBe("fast");
});

test("reference prices preserve each original request's long-context band", () => {
  expect(priceCodexEvent(config, { ...event, speed: "standard", in_tok: 200001 }, "api_equivalent_usd", "2026-08-01")).toMatchObject({ long_context: true, amount: 0.600003 });
  expect(priceCodexEvent(config, { ...event, speed: "standard", in_tok: 200000 }, "api_equivalent_usd", "2026-08-01")).toMatchObject({ long_context: false, amount: 0.2 });
});

test("missing historic or reference rates never enter either paired amount", () => {
  for (const [historic, reference] of [[null, 5], [5, null], [null, null]] as const) {
    const usage = { ...emptyWindowUsage(), events: 1, tokens: 100 };
    addReferenceValuation(usage, historic, reference);
    expect(usage).toMatchObject({ paired_historical_api: 0, paired_reference_api: 0, revaluation_events: 0, revaluation_tokens: 0 });
    expect(usage.reference_priced_tokens).toBe(reference === null ? 0 : 100);
  }
  const [window] = codexWindowsFixture(config, publishedCodexComparisonFixture(config,[event],"2026-10-01"), probes, 10080, "2026-10-01");
  expect(window!.usage).toMatchObject({ reference_unpriced_events: 1, revaluation_events: 0 });
});
