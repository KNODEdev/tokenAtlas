import { test, expect } from "bun:test";
import { auditComparisonPassed } from "./audit-subscription-window";

test("independent regression fails closed on missing or mismatched amounts", () => {
  const values = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), { match: true }]));
  expect(auditComparisonPassed({ observed: values, cycle: values })).toBe(true);
  expect(auditComparisonPassed({ observed: values })).toBe(false);
  expect(auditComparisonPassed({ observed: values, cycle: { ...values, "3": { match: false } } })).toBe(false);
  expect(auditComparisonPassed(null)).toBe(false);
});
