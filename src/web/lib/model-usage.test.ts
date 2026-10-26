import { describe, expect, test } from "bun:test";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";
import { codexModelUsage, detailModelUsage } from "./model-usage";

type Row = CodexAccountingReport["breakdown"][number];
type Coverage = Row["normalization"]["standard_api_usd"];
const coverage = (priced: number, pricedEvents: number, unpricedEvents = 0): Coverage =>
  ({ value: null, priced_subtotal: priced, status: "partial", priced_events: pricedEvents, unpriced_events: unpricedEvents, priced_tokens: 0, unpriced_tokens: 0, reasons: {} });
function codexRow(model: string | null, speed: string, tokens: number, events: number, api: Coverage, extra = coverage(0, 0)): Row {
  return { day: "2026-09-01", model, speed, account: "codex1", home: "C:/Users/a/.codex", events, tokens,
    amounts: { chatgpt_credits: api, api_equivalent_usd: api },
    normalization: { standard_api_usd: api, normalized_usd: api, standard_credits: api, extra_credits: extra } };
}
function detail(model: string, speed: string, tokens: number, calls: number, api: number | null): SubscriptionModelDetail {
  return { day: "2026-09-01", model, speed, source: "cli", calls, tokens, quantities: {}, rates: {}, costs: {}, api_standard: api, api_actual: null, pricing_source: null, pricing_note: "" };
}

describe("model usage aggregation", () => {
  test("Codex rows fold into one row per model with mode split, calls and a lower-bound Standard value", () => {
    const summary = codexModelUsage([
      codexRow("gpt-6-sol", "standard", 600, 3, coverage(6, 3)),
      codexRow("gpt-6-sol", "unknown", 300, 2, coverage(0, 0, 2)),
      codexRow("gpt-6-astra", "fast", 100, 1, coverage(4, 1), coverage(2.5, 1)),
      codexRow("gpt-6-astra", "standard", 50, 1, coverage(1, 1)),
      codexRow(null, "unknown", 5_000, 9, coverage(0, 0, 9)),
    ]);
    expect(summary.rows.map(row => row.model)).toEqual(["gpt-6-sol", "gpt-6-astra", null]);
    expect(summary.rows[0]).toEqual({ model: "gpt-6-sol", tokens: 900, calls: 5, modes: { standard: 600, fast: 0, unknown: 300 },
      apiUsd: 6, apiPartial: true, extraCredits: null, extraPartial: false });
    expect(summary.rows[1]).toMatchObject({ tokens: 150, modes: { standard: 50, fast: 100, unknown: 0 }, apiUsd: 5, apiPartial: false, extraCredits: 2.5 });
    // Nothing of the unnamed traffic is priced: no value, not a zero.
    expect(summary.rows[2]).toMatchObject({ apiUsd: null, apiPartial: true });
    expect(summary).toMatchObject({ tokens: 6_050, calls: 16, modes: { standard: 650, fast: 100, unknown: 5_300 }, apiUsd: 11, apiPartial: true });
  });

  test("detail rows of other providers treat a missing Standard value as unpriced, never as zero", () => {
    const summary = detailModelUsage([
      detail("claude-opus-5-5", "standard", 900, 4, 3),
      detail("claude-opus-5-5", "unknown", 100, 1, null),
      detail("claude-fable-5-1", "standard", 400, 2, 1.5),
    ]);
    expect(summary.rows.map(row => [row.model, row.tokens, row.apiUsd, row.apiPartial])).toEqual([
      ["claude-opus-5-5", 1_000, 3, true],
      ["claude-fable-5-1", 400, 1.5, false],
    ]);
    expect(summary.modes).toEqual({ standard: 1_300, fast: 0, unknown: 100 });
    expect(summary.apiUsd).toBe(4.5);
    expect(detailModelUsage([detail("x", "standard", 10, 1, null)])).toMatchObject({ apiUsd: null, apiPartial: true });
  });
});
