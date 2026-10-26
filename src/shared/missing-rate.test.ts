import { expect, test } from "bun:test";
import { missingRateIn, missingRateSummary } from "./missing-rate";

const known = new Set(["openai::codex-auto-review", "openai::gpt-5-codex"]);
const knownUnpriced = (vendor: string, model: string) => known.has(`${vendor}::${model}`);

test("the summary lists models without a price and leaves out intentionally unpriced ones", () => {
  const summary = missingRateSummary([
    { model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 2_300_000_000 },
    { model: "codex-auto-review", observed_provider: "openai", rate_vendor: "openai", tokens: 900 },
    { model: "gpt-5-codex", observed_provider: "openai", rate_vendor: "openai", tokens: 500 },
    { model: "claude-new", observed_provider: "anthropic", rate_vendor: "anthropic", tokens: 40 },
    { model: "claude-new", observed_provider: "anthropic", rate_vendor: "anthropic", tokens: 2 },
    // Not priceable in Settings: a provider without any rate card, an unidentified model.
    { model: "foreign-model", observed_provider: "someone", rate_vendor: null, tokens: 70 },
    { model: "?", observed_provider: "openai", rate_vendor: "openai", tokens: 3 },
  ], knownUnpriced);
  expect(summary).toEqual({ tokens: 2_300_000_042, models: [
    { model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 2_300_000_000 },
    { model: "claude-new", observed_provider: "anthropic", rate_vendor: "anthropic", tokens: 42 },
  ], unpriceable: [{ model: "foreign-model", observed_provider: "someone", rate_vendor: null, tokens: 70 }] });
  expect(missingRateSummary([{ model: "codex-auto-review", observed_provider: "openai", rate_vendor: "openai", tokens: 9 }], knownUnpriced))
    .toEqual({ tokens: 0, models: [] });
});

test("a window counts only the unpriced tokens of missing-rate models", () => {
  const summary = missingRateSummary([{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 10 }], knownUnpriced);
  expect(missingRateIn([{ model: "gpt-new-sol", tokens: 7 }, { model: "codex-auto-review", tokens: 5 }, { model: "gpt-5.5", tokens: 3 }], summary))
    .toEqual({ tokens: 7, models: [{ model: "gpt-new-sol", tokens: 7 }] });
  // The breakdown responses carry the same counts as a model → tokens record.
  expect(missingRateIn({ "gpt-new-sol": 4, "codex-auto-review": 1 }, summary)).toEqual({ tokens: 4, models: [{ model: "gpt-new-sol", tokens: 4 }] });
  expect(missingRateIn([{ model: "gpt-new-sol", tokens: 7 }], null)).toEqual({ tokens: 0, models: [] });
  expect(missingRateIn(undefined, summary)).toEqual({ tokens: 0, models: [] });
});
