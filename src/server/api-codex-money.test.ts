import { expect, test } from "bun:test";
import { ApiCodexMoney, roundApiCodexUsd, roundApiCodexUsdWithLegacy } from "./api-codex-ledger";
import { add, decimal, rational } from "../db/price-ledger-exact";

test("native API money rounds exact cents before conversion, including large and signed ties", () => {
  for (const [source, expected] of [
    ["0.145", 0.15], ["10000.005", 10000.01], ["10000.0049999999999998", 10000],
    ["-10000.005", -10000.01], ["-10000.0049999999999998", -10000], ["-0.005", -0.01],
    ["0", 0], ["-0.001", 0], ["0.001", 0],
  ] as const) expect(roundApiCodexUsd(decimal(source))).toBe(expected);
  expect(Object.is(roundApiCodexUsd(decimal("-0.001")), -0)).toBe(false);
  expect(roundApiCodexUsd(rational(1n, 3n))).toBe(0.33);
});

test("rounding whole exact totals is independent of rounded bucket values", () => {
  const amount = decimal("0.004"), money = new ApiCodexMoney(), a = { usd: 0 }, b = { usd: 0 };
  money.add(a, amount); money.add(b, amount); money.finish();
  expect(money.rounded(a)).toBe(0); expect(money.rounded(b)).toBe(0);
  expect(roundApiCodexUsd(add(money.exact(a)!, money.exact(b)!))).toBe(0.01);
  expect(roundApiCodexUsdWithLegacy(amount, 0.004)).toBe(0.01);
});

test("mixed targets retain legacy contributions merged before and after native collection", () => {
  const money = new ApiCodexMoney(), before = { usd: 0.004 }, after = { usd: 0 };
  money.add(before, decimal("0.004")); money.add(after, decimal("10000.0049999999999998")); money.finish();
  money.addLegacy(after, 0.004); after.usd += 0.004;
  expect(money.rounded(before)).toBe(0.01); expect(money.rounded(after)).toBe(10000.01);
  expect(money.exact(after)).toEqual(decimal("10000.0089999999999998"));
  expect(money.rounded({ usd: 1.005 })).toBeUndefined();
});

test("an unpriced target keeps NULL while its priced subtotal remains exact", () => {
  const money = new ApiCodexMoney(), target = { usd: null, priced_usd: 0.004 };
  money.add(target, decimal("0.004")); money.finish();
  expect(target.usd).toBeNull(); expect(money.rounded(target)).toBe(0.01);
});
