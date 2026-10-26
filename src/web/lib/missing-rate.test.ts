import { expect, test } from "bun:test";
import { setLanguage } from "./i18n";
import { missingRateAlert, unpricedTableRows } from "./missing-rate";

const summary = { tokens: 12, models: [{ model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 12, first_day: "2026-09-30" }],
  unpriceable: [{ model: "stealth/x", observed_provider: "openrouter", rate_vendor: null, tokens: 5 }] };

test("the Settings table lists exactly the alert's models, then vendors without a rate card", () => {
  setLanguage("en");
  expect(unpricedTableRows(summary)).toEqual({ tokens: 12, items: [
    { model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 12, first_day: "2026-09-30", reason: "missing_rate" },
    { model: "stealth/x", observed_provider: "openrouter", rate_vendor: null, tokens: 5, reason: "no_rate_card" },
  ] });
  // The alert names only what can be priced in Settings.
  expect(missingRateAlert(summary)?.detail).toBe("gpt-new-sol (12 tokens) — enter the price in Settings → Price lists → Models");
  expect(missingRateAlert({ tokens: 0, models: [], unpriceable: summary.unpriceable as never })).toBeNull();
  expect(unpricedTableRows(null)).toBeUndefined();
});
