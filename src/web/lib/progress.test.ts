import { expect, test } from "bun:test";
import type { ProgressEntry } from "../../shared/progress";
import { overallFraction, scopeFraction } from "./progress";

const entry = (scope: string, step: string, done: number, total: number | null): ProgressEntry =>
  ({ scope, step, label: step, done, total, unit: "items", startedAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:01Z" });

test("a scope with ordered steps counts its finished steps and the share of the current one", () => {
  // The usage ledger runs five steps; halfway through the second is 1.5 of 5.
  expect(scopeFraction(entry("usage-ledger:claude", "resolve", 50, 100))).toBeCloseTo(0.3);
  expect(scopeFraction(entry("codex-ledger", "aggregates", 6, 6))).toBe(1);
  expect(scopeFraction(entry("window-usage", "sums", 60, 573))).toBeCloseTo(60 / 573);
  // An unknown total is no progress within the step, never a division by zero.
  expect(scopeFraction(entry("limit-windows", "windows", 3, null))).toBe(0);
});

test("the overall share is the mean of the stretch's scopes, and a scope that left the register counts as done", () => {
  const seen = new Map<string, number>();
  expect(overallFraction([], seen)).toBeNull();
  expect(overallFraction([entry("window-usage", "sums", 1, 4), entry("limit-windows", "windows", 3, 4)], seen)).toBeCloseTo(0.5);
  // Limit windows finished and left; a new scope joins at zero.
  expect(overallFraction([entry("window-usage", "sums", 3, 4), entry("account-periods", "feed", 0, 10)], seen)).toBeCloseTo((0.75 + 1 + 0) / 3);
});
