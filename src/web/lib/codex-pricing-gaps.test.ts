import { describe, expect, test } from "bun:test";
import type { AmountCoverage, CodexAccountingReport } from "../../shared/codex-accounting";
import { codexPricingGaps, type CodexPricingGap } from "./codex-pricing-gaps";

type BreakdownRow = CodexAccountingReport["breakdown"][number];
type Counts = { events: number; tokens: number };

interface RowOptions {
  standardApi?: Counts;
  actualApi?: Counts;
  standardCredits?: Counts;
  actualCredits?: Counts;
  standardApiReasons?: Record<string, Counts>;
  actualApiReasons?: Record<string, Counts>;
  standardCreditsReasons?: Record<string, Counts>;
  actualCreditsReasons?: Record<string, Counts>;
}

function coverage(missing: Counts | undefined, otherReasons: Record<string, Counts> = {}): AmountCoverage {
  const reasons = { ...otherReasons, ...(missing ? { missing_rate: missing } : {}) };
  const unpriced = Object.values(reasons).reduce(
    (sum, counts) => ({ events: sum.events + counts.events, tokens: sum.tokens + counts.tokens }),
    { events: 0, tokens: 0 },
  );
  return {
    value: Object.keys(reasons).length === 0 ? 0 : null,
    priced_subtotal: 0,
    status: Object.keys(reasons).length === 0 ? "complete" : "unpriced",
    priced_events: 0,
    unpriced_events: unpriced.events,
    priced_tokens: 0,
    unpriced_tokens: unpriced.tokens,
    reasons,
  };
}

function row(day: string, model: string | null, speed: string, options: RowOptions = {}): BreakdownRow {
  const standardApi = coverage(options.standardApi, options.standardApiReasons);
  const actualApi = coverage(
    options.actualApi ?? (speed === "standard" ? options.standardApi : undefined),
    options.actualApiReasons,
  );
  const standardCredits = coverage(options.standardCredits, options.standardCreditsReasons);
  const actualCredits = coverage(
    options.actualCredits ?? (speed === "standard" ? options.standardCredits : undefined),
    options.actualCreditsReasons,
  );
  return {
    day,
    model,
    speed,
    account: "codex1",
    home: "fixture",
    events: 0,
    tokens: 0,
    amounts: {
      api_equivalent_usd: actualApi,
      chatgpt_credits: actualCredits,
    },
    normalization: {
      standard_api_usd: standardApi,
      normalized_usd: coverage(undefined),
      standard_credits: standardCredits,
      extra_credits: coverage(undefined),
    },
  } as BreakdownRow;
}

function gapsFor(gaps: CodexPricingGap[], model: string, basis: CodexPricingGap["basis"], speed: CodexPricingGap["speed"]): CodexPricingGap[] {
  return gaps.filter((gap) => gap.model === model && gap.basis === basis && gap.speed === speed);
}

describe("codexPricingGaps", () => {
  test("does not double-count Standard actual and normalized coverage for the same row", () => {
    const gaps = codexPricingGaps({
      breakdown: [row("2026-08-01", "gpt-6-astra", "standard", {
        standardApi: { events: 2, tokens: 200 },
        standardCredits: { events: 3, tokens: 300 },
      })],
    });

    expect(gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "standard")).toEqual([{
      model: "gpt-6-astra", basis: "api_equivalent_usd", speed: "standard",
      since: "2026-08-01", until: "2026-08-01", days: 1, events: 2, tokens: 200,
    }]);
    expect(gapsFor(gaps, "gpt-6-astra", "chatgpt_credits", "standard")).toEqual([{
      model: "gpt-6-astra", basis: "chatgpt_credits", speed: "standard",
      since: "2026-08-01", until: "2026-08-01", days: 1, events: 3, tokens: 300,
    }]);
  });

  test("keeps Fast and Standard missing rates separate for each billing basis", () => {
    const gaps = codexPricingGaps({
      breakdown: [row("2026-08-02", "gpt-6-astra", "fast", {
        standardApi: { events: 2, tokens: 200 },
        actualApi: { events: 5, tokens: 500 },
        standardCredits: { events: 3, tokens: 300 },
        actualCredits: { events: 7, tokens: 700 },
      })],
    });

    expect(gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "standard")[0]).toMatchObject({ events: 2, tokens: 200 });
    expect(gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "fast")[0]).toMatchObject({ events: 5, tokens: 500 });
    expect(gapsFor(gaps, "gpt-6-astra", "chatgpt_credits", "standard")[0]).toMatchObject({ events: 3, tokens: 300 });
    expect(gapsFor(gaps, "gpt-6-astra", "chatgpt_credits", "fast")[0]).toMatchObject({ events: 7, tokens: 700 });
  });

  test("suggests Standard gaps for unknown speed without inventing a Fast gap", () => {
    const gaps = codexPricingGaps({
      breakdown: [row("2026-08-03", "gpt-6-astra", "unknown", {
        standardApi: { events: 4, tokens: 400 },
        standardCredits: { events: 6, tokens: 600 },
      })],
    });

    expect(gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "standard")[0]).toMatchObject({ events: 4, tokens: 400 });
    expect(gapsFor(gaps, "gpt-6-astra", "chatgpt_credits", "standard")[0]).toMatchObject({ events: 6, tokens: 600 });
    expect(gaps.some((gap) => gap.speed === "fast")).toBe(false);
  });

  test("merges consecutive days while an idle calendar day splits ranges", () => {
    const gaps = codexPricingGaps({
      breakdown: [
        row("2026-08-01", "gpt-6-astra", "standard", { standardApi: { events: 1, tokens: 100 } }),
        row("2026-08-03", "gpt-6-astra", "standard", { standardApi: { events: 2, tokens: 200 } }),
        row("2026-08-04", "gpt-6-astra", "standard", { standardApi: { events: 3, tokens: 300 } }),
      ],
    });
    const apiStandard = gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "standard");

    expect(apiStandard).toEqual([
      {
        model: "gpt-6-astra", basis: "api_equivalent_usd", speed: "standard",
        since: "2026-08-01", until: "2026-08-01", days: 1, events: 1, tokens: 100,
      },
      {
        model: "gpt-6-astra", basis: "api_equivalent_usd", speed: "standard",
        since: "2026-08-03", until: "2026-08-04", days: 2, events: 5, tokens: 500,
      },
    ]);
  });

  test("skips unknown models, non-missing-rate reasons, and keeps model/basis attribution", () => {
    const gaps = codexPricingGaps({
      breakdown: [
        row("2026-08-05", null, "standard", { standardApi: { events: 9, tokens: 900 } }),
        row("2026-08-05", "gpt-6-astra", "standard", {
          standardApiReasons: { unknown_speed: { events: 8, tokens: 800 } },
          standardCreditsReasons: { invalid_tokens: { events: 7, tokens: 700 } },
        }),
        row("2026-08-05", "gpt-5.6-luna", "standard", {
          standardCredits: { events: 2, tokens: 200 },
        }),
      ],
    });

    expect(gapsFor(gaps, "gpt-6-astra", "api_equivalent_usd", "standard")).toEqual([]);
    expect(gapsFor(gaps, "gpt-6-astra", "chatgpt_credits", "standard")).toEqual([]);
    expect(gapsFor(gaps, "gpt-5.6-luna", "api_equivalent_usd", "standard")).toEqual([]);
    expect(gapsFor(gaps, "gpt-5.6-luna", "chatgpt_credits", "standard")).toEqual([{
      model: "gpt-5.6-luna", basis: "chatgpt_credits", speed: "standard",
      since: "2026-08-05", until: "2026-08-05", days: 1, events: 2, tokens: 200,
    }]);
  });
});
