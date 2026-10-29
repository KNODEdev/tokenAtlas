import { expect, test } from "bun:test";
import { addMonthsUtc, deriveBillingCycles, usdEquivalent, type CatalogCyclePrice, type CyclePlanRow, type DerivedCycle, type FxLookup } from "./billing-cycles";

const CATALOG: Record<string, number> = { pro: 20, "max-5x": 100, "max-20x": 200, plus: 20, free: 0 };
const price: CatalogCyclePrice = (plan, _day, months) => CATALOG[plan] === undefined ? null : CATALOG[plan]! * months;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const declared = (plan: string, from: string, until: string | null, extra: Partial<CyclePlanRow> = {}): CyclePlanRow =>
  ({ origin: "declared", plan, from, until, ...extra });
const observed = (plan: string, from: string, until: string | null, lastSeen: string | null = until): CyclePlanRow =>
  ({ origin: "observed", plan, from, until, lastSeen });
const brief = (cycles: DerivedCycle[]) => cycles.map((c) => [iso(c.start).slice(0, 16), iso(c.end).slice(0, 16), c.plan, c.basis,
  c.amountMinor, c.currency, c.priceSource, c.shortened, c.current]);

test("calendar months keep the day and time; a missing day falls to the month's last", () => {
  expect(iso(addMonthsUtc(at("2026-01-31T10:00:00Z"), 1))).toBe("2026-02-28T10:00:00.000Z");
  expect(iso(addMonthsUtc(at("2026-01-31T10:00:00Z"), 2))).toBe("2026-03-31T10:00:00.000Z");
  expect(iso(addMonthsUtc(at("2026-03-31T10:00:00Z"), -1))).toBe("2026-02-28T10:00:00.000Z");
  expect(iso(addMonthsUtc(at("2026-09-24T09:55:57.164Z"), 12))).toBe("2027-09-24T09:55:57.164Z");
});

test("a declared run: its full-cycle payment is repeated by the later cycles (18.10); future cycles are not listed", () => {
  const cycles = deriveBillingCycles([declared("max-20x", "2026-07-03", null, { amountMinor: 16309, currency: "EUR" })], [],
    { now: at("2026-09-10T00:00:00Z"), price });
  expect(brief(cycles)).toEqual([
    ["2026-07-03T00:00", "2026-08-03T00:00", "max-20x", "declared", 16309, "EUR", "declared", false, false],
    ["2026-08-03T00:00", "2026-09-03T00:00", "max-20x", "declared", 16309, "EUR", "repeated", false, false],
    ["2026-09-03T00:00", "2026-10-03T00:00", "max-20x", "declared", 16309, "EUR", "repeated", false, true],
  ]);
});

test("a prorated surcharge or a voided payment is not repeated: the later cycles take the catalog price", () => {
  const now = at("2026-11-10T00:00:00Z");
  // The anchor puts the renewal on the 9th: the payment from the 20th covered the rest of a cycle only.
  const surcharge = deriveBillingCycles([declared("pro", "2026-09-20", null, { amountMinor: 50602, currency: "PLN", anchor: "2026-09-09" })], [], { now, price });
  expect(brief(surcharge).map((row) => row.slice(4, 7))).toEqual([[50602, "PLN", "declared"], [2000, "USD", "catalog"], [2000, "USD", "catalog"]]);
  const voided = deriveBillingCycles([declared("pro", "2026-09-09", null, { amountMinor: 0, currency: "PLN" })], [], { now, price });
  expect(brief(voided).map((row) => row.slice(4, 7))).toEqual([[0, "PLN", "declared"], [2000, "USD", "catalog"], [2000, "USD", "catalog"]]);
});

test("a payment right after a mid-cycle plan change is a surcharge: later cycles take the last full payment of that plan, else the catalog", () => {
  const now = at("2026-11-30T00:00:00Z");
  // claude-ea41: full 20x 180 € on 03.08, Pro and 5x from September, 20x again on 24.09 for 113.78 € (180 € less the unused 5x).
  const rows = [
    declared("max-20x", "2026-08-03", "2026-09-03", { amountMinor: 18000, currency: "EUR" }),
    declared("pro", "2026-09-09", "2026-09-12T13:35:26.181Z", { amountMinor: 1615, currency: "EUR" }),
    declared("max-5x", "2026-09-12T13:35:26.181Z", "2026-09-24T09:55:57.164Z", { amountMinor: 6705, currency: "EUR" }),
    declared("max-20x", "2026-09-24T09:55:57.164Z", null, { amountMinor: 11378, currency: "EUR" }),
  ];
  expect(brief(deriveBillingCycles(rows, [], { now, price })).slice(-3).map((row) => [row[0], row[2], ...row.slice(4, 7)])).toEqual([
    ["2026-09-24T09:55", "max-20x", 11378, "EUR", "declared"],
    ["2026-10-24T09:55", "max-20x", 18000, "EUR", "repeated"],
    ["2026-11-24T09:55", "max-20x", 18000, "EUR", "repeated"],
  ]);
  // Without an earlier full payment of the plan the catalog prices the later cycles.
  expect(brief(deriveBillingCycles(rows.slice(1), [], { now, price })).slice(-2).map((row) => row.slice(4, 7)))
    .toEqual([[20000, "USD", "catalog"], [20000, "USD", "catalog"]]);
  // A change on the previous plan's renewal day is a full payment, repeated as before.
  const onRenewal = deriveBillingCycles([declared("max-5x", "2026-08-12", "2026-09-12", { amountMinor: 9000, currency: "EUR" }),
    declared("max-20x", "2026-09-12", null, { amountMinor: 18000, currency: "EUR" })], [], { now, price });
  expect(brief(onRenewal).slice(-2).map((row) => row.slice(4, 7))).toEqual([[18000, "EUR", "repeated"], [18000, "EUR", "repeated"]]);
});

test("a surcharge reuses only a full payment with the same billing interval", () => {
  for (const [previousMonths, nextMonths] of [[12, 1], [1, 12]] as const) {
    const rows = [
      declared("max-20x", "2025-01-01", "2026-01-01", { cycleMonths: previousMonths, amountMinor: previousMonths === 12 ? 120000 : 18000, currency: "USD" }),
      declared("pro", "2026-01-01", "2026-01-15", { amountMinor: 2000, currency: "USD" }),
      declared("max-20x", "2026-01-15", null, { cycleMonths: nextMonths, amountMinor: 1000, currency: "USD" }),
    ];
    const cycles = deriveBillingCycles(rows, [], { now: at("2027-02-01T00:00:00Z"), price });
    const renewed = cycles.filter(cycle => cycle.run.from === at("2026-01-15") && cycle.priceSource !== "declared");
    expect(renewed.length).toBeGreaterThan(0);
    expect(renewed.map(cycle => [cycle.amountMinor, cycle.currency, cycle.priceSource]))
      .toEqual(renewed.map(() => [20000 * nextMonths, "USD", "catalog"]));
  }
});

test("starting a paid plan after no subscription or a free plan repeats its full payment", () => {
  for (const prior of ["none", "free"]) {
    const cycles = deriveBillingCycles([
      declared(prior, "2026-01-01", "2026-01-15"),
      declared("pro", "2026-01-15", null, { amountMinor: 3000, currency: "USD" }),
    ], [], { now: at("2026-03-20T00:00:00Z"), price });
    expect(cycles.filter(cycle => cycle.plan === "pro").map(cycle => [cycle.amountMinor, cycle.priceSource]))
      .toEqual([[3000, "declared"], [3000, "repeated"], [3000, "repeated"]]);
  }
});

test("a payment carries its USD equivalent at the stored NBP rate of its day; a missing rate is unknown, never 0", () => {
  const rates: Record<string, number> = { "USD|2026-09-16": 3.6512, "USD|2026-10-16": 3.7, "EUR|2026-10-16": 4.25 };
  const fx: FxLookup = (currency, onDay) => rates[`${currency}|${onDay}`] === undefined ? null
    : { plnPerUnit: rates[`${currency}|${onDay}`]!, effectiveDay: "2026-10-15", tableNo: "200/A/NBP/2026" };
  const cycles = deriveBillingCycles([declared("pro", "2026-09-16", null, { amountMinor: 81300, currency: "PLN" })], [],
    { now: at("2026-11-20T00:00:00Z"), price, fx });
  expect(cycles.map((c) => [c.priceSource, c.amountUsd])).toEqual([["declared", 222.67], ["repeated", 219.73], ["repeated", null]]);
  expect(cycles[1]!.fx).toEqual({ currency: "PLN", day: "2026-10-16", rate: 1, usd_rate: 3.7, effective_day: "2026-10-15", table: "200/A/NBP/2026" });
  expect(cycles[2]!.fx).toMatchObject({ currency: "PLN", day: "2026-11-16", usd_rate: null });
  expect(usdEquivalent(10000, "EUR", "2026-10-16", fx).usd).toBe(114.86);
  expect(usdEquivalent(10000, "usd", "2026-10-16").usd).toBe(100);
  expect(usdEquivalent(null, "PLN", "2026-10-16", fx)).toEqual({ usd: null, fx: null });
  // EUR goes through PLN with both rates of the day; without its own rate it stays unknown though USD is stored.
  expect(usdEquivalent(10000, "EUR", "2026-09-16", fx)).toMatchObject({ usd: null, fx: { currency: "EUR", rate: null, usd_rate: 3.6512 } });
  // No ISO currency: nothing to fetch, never a pending rate.
  expect(usdEquivalent(10000, null, "2026-10-16", fx)).toEqual({ usd: null, fx: null });
  expect(usdEquivalent(10000, "zł", "2026-10-16", fx)).toEqual({ usd: null, fx: null });
});

test("a plan change starts a new run: the cycle before it ends early; the anchor moves the renewal day", () => {
  const rows = [declared("pro", "2026-09-09", "2026-09-12T13:35:26.181Z", { amountMinor: 1615, currency: "EUR" }),
    declared("max-5x", "2026-09-12T13:35:26.181Z", null, { anchor: "2026-09-09" })];
  const cycles = deriveBillingCycles(rows, [], { now: at("2026-10-20T00:00:00Z"), price });
  expect(brief(cycles)).toEqual([
    ["2026-09-09T00:00", "2026-09-12T13:35", "pro", "declared", 1615, "EUR", "declared", true, false],
    // The anchor keeps the 9th as the payment day: the first 5x cycle is the rest of the paid month.
    ["2026-09-12T13:35", "2026-10-09T00:00", "max-5x", "declared", Math.round(10000 * (at("2026-10-09T00:00:00Z") - at("2026-09-12T13:35:26.181Z")) / (at("2026-10-09T00:00:00Z") - at("2026-09-09T00:00:00Z"))), "USD", "catalog", true, false],
    ["2026-10-09T00:00", "2026-11-09T00:00", "max-5x", "declared", 10000, "USD", "catalog", false, true],
  ]);
});

test("an annual plan has one cycle per year; a trial declared at 0 is a known price of 0, not a missing one", () => {
  const annual = deriveBillingCycles([declared("pro", "2026-01-15", null, { cycleMonths: 12 })], [], { now: at("2027-02-01T00:00:00Z"), price });
  expect(brief(annual).map((row) => row.slice(0, 2))).toEqual([["2026-01-15T00:00", "2027-01-15T00:00"], ["2027-01-15T00:00", "2028-01-15T00:00"]]);
  expect(annual[0]!.catalogUsd).toBe(240);
  const trial = deriveBillingCycles([declared("pro", "2026-09-03", "2026-09-10", { amountMinor: 0, currency: "EUR" })], [], { now: at("2026-10-01T00:00:00Z"), price });
  expect(brief(trial)).toEqual([["2026-09-03T00:00", "2026-09-10T00:00", "pro", "declared", 0, "EUR", "declared", true, false]]);
});

test("no subscription has no cycles; Free keeps zero-priced capacity cycles; an unknown price stays unknown", () => {
  const now = at("2026-09-30T00:00:00Z");
  expect(deriveBillingCycles([declared("none", "2026-06-18", "2026-07-01")], [], { now, price })).toEqual([]);
  const free = deriveBillingCycles([observed("free", "2026-09-01T00:00:00Z", null, "2026-09-30T00:00:00Z")], [], { now, price });
  expect(free).toHaveLength(1);
  expect(free[0]).toMatchObject({ plan: "free", catalogUsd: 0, amountMinor: 0, currency: "USD", amountUsd: 0 });
  const unknown = deriveBillingCycles([declared("enterprise", "2026-09-01", null)], [], { now, price });
  expect(brief(unknown)).toEqual([["2026-09-01T00:00", "2026-10-01T00:00", "enterprise", "declared", null, null, "catalog", false, true]]);
});

test("a known zero payment needs no exchange rate", () => {
  expect(usdEquivalent(0, "EUR", "2026-09-01")).toEqual({ usd: 0, fx: null });
  expect(usdEquivalent(0, "PLN", "2026-09-01")).toEqual({ usd: 0, fx: null });
  expect(usdEquivalent(100, "EUR", "2026-09-01").usd).toBeNull();
});

test("after a declared end, readings of the same plan add no cycles: the end is the owner's (29.10)", () => {
  const rows = [declared("max-20x", "2026-08-03", "2026-09-03", { amountMinor: 18000, currency: "EUR" }),
    // Readings from before the end on are cut at the declared end (22.09 rule).
    observed("max-20x", "2026-08-20T00:00:00Z", null, "2026-10-10T00:00:00Z")];
  const cycles = deriveBillingCycles(rows, [], { now: at("2026-12-01T00:00:00Z"), price });
  expect(brief(cycles)).toEqual([
    ["2026-08-03T00:00", "2026-09-03T00:00", "max-20x", "declared", 18000, "EUR", "declared", false, false],
  ]);
});

test("a stretch between two declarations stays a gap whatever readings show (29.10)", () => {
  // codex1: the owner's 16.08-16.09, 16.09-16.10 and 21.10-21.11 with readings of Pro throughout.
  const between = [declared("pro", "2026-08-16", "2026-09-16"), declared("pro", "2026-09-16", "2026-10-16"), declared("pro", "2026-10-21T17:30:00Z", "2026-11-21T17:30:00Z"),
    observed("pro", "2026-09-09T15:11:32.698Z", null, "2026-10-29T16:00:00Z")];
  expect(brief(deriveBillingCycles(between, [], { now: at("2026-10-29T16:00:00Z"), price })).map((row) => row.slice(0, 4))).toEqual([
    ["2026-08-16T00:00", "2026-09-16T00:00", "pro", "declared"],
    ["2026-09-16T00:00", "2026-10-16T00:00", "pro", "declared"],
    ["2026-10-21T17:30", "2026-11-21T17:30", "pro", "declared"],
  ]);
  // Readings that start inside the gap do not fill it either.
  const inside = [declared("plus", "2026-08-19T18:15:05Z", "2026-09-09T15:11:32.717Z"), declared("plus", "2026-10-06", null),
    observed("plus", "2026-09-09T15:11:32.717Z", "2026-10-19T17:28:13.435Z")];
  expect(brief(deriveBillingCycles(inside, [], { now: at("2026-10-29T16:00:00Z"), price })).map((row) => row.slice(0, 4))).toEqual([
    ["2026-08-19T18:15", "2026-09-09T15:11", "plus", "declared"],
    ["2026-10-06T00:00", "2026-11-06T00:00", "plus", "declared"],
  ]);
});

test("evidence inside the first 24 h of a cycle does not infer it", () => {
  const rows = [declared("pro", "2026-08-03", "2026-09-03"), observed("pro", "2026-09-03T05:00:00Z", "2026-09-03T20:00:00Z")];
  // The short readings are a run of their own (from readings), not an inferred continuation.
  expect(deriveBillingCycles(rows, [], { now: at("2026-10-01T00:00:00Z"), price }).map((c) => c.basis)).toEqual(["declared", "observed"]);
});

test("a no-subscription row blocks readings; readings inside declarations add no cycles", () => {
  const blocked = [declared("max-20x", "2026-08-03", "2026-09-03"), declared("none", "2026-09-03", null),
    observed("max-20x", "2026-08-20T00:00:00Z", null, "2026-10-10T00:00:00Z")];
  expect(deriveBillingCycles(blocked, [], { now: at("2026-12-01T00:00:00Z"), price }).map((c) => c.basis)).toEqual(["declared"]);
  // socialmedia@ (§4): the 20x readings of 24.09 lie inside the declared 20x row; the gap 03.09-09.09 gets no cycle.
  const inside = [declared("max-20x", "2026-08-03", "2026-09-03"), declared("pro", "2026-09-09", "2026-09-12"),
    declared("max-20x", "2026-09-12", null), observed("max-20x", "2026-09-24T12:53:06.436Z", null, "2026-10-08T10:29:33.231Z")];
  expect(brief(deriveBillingCycles(inside, [], { now: at("2026-10-08T14:30:00Z"), price })).map((row) => row.slice(0, 4))).toEqual([
    ["2026-08-03T00:00", "2026-09-03T00:00", "max-20x", "declared"],
    ["2026-09-09T00:00", "2026-09-12T00:00", "pro", "declared"],
    ["2026-09-12T00:00", "2026-10-12T00:00", "max-20x", "declared"],
  ]);
});

test("later evidence after a broken chain is a new observed run with an uncertain payment day", () => {
  const rows = [declared("pro", "2026-06-01", "2026-07-01"), observed("pro", "2026-08-15T08:00:00Z", null, "2026-09-20T00:00:00Z")];
  const cycles = deriveBillingCycles(rows, [], { now: at("2026-09-20T00:00:00Z"), price });
  expect(brief(cycles).map((row) => row.slice(0, 4))).toEqual([
    ["2026-06-01T00:00", "2026-07-01T00:00", "pro", "declared"],
    ["2026-08-15T08:00", "2026-09-15T08:00", "pro", "observed"],
    ["2026-09-15T08:00", "2026-10-15T08:00", "pro", "observed"],
  ]);
  expect(cycles.filter((c) => c.basis === "observed").every((c) => c.anchorUncertain)).toBe(true);
});

test("an observed run is anchored at the first limit window carrying its plan, never across another plan (§12.2)", () => {
  const windows = [
    { start: at("2026-08-24T06:00:00Z"), end: at("2026-08-31T06:00:00Z"), plan: "plus" },
    { start: at("2026-08-31T06:09:36Z"), end: at("2026-09-07T06:09:36Z"), plan: "pro" },
    { start: at("2026-09-07T08:06:08Z"), end: at("2026-09-08T01:21:49Z"), plan: "pro" },
    { start: at("2026-09-08T21:06:19Z"), end: at("2026-09-12T08:10:13Z"), plan: "pro" },
  ];
  const rows = [observed("pro", "2026-09-09T15:11:32.698Z", null, "2026-10-08T14:30:35.167Z")];
  const cycles = deriveBillingCycles(rows, windows, { now: at("2026-10-08T14:30:00Z"), price });
  expect(brief(cycles).map((row) => row.slice(0, 4))).toEqual([
    ["2026-08-31T06:09", "2026-09-30T06:09", "pro", "observed"],
    ["2026-09-30T06:09", "2026-10-31T06:09", "pro", "observed"],
  ]);
  // A window without the plan breaks the walk back.
  const broken = windows.map((w, index) => index === 2 ? { ...w, plan: null } : w);
  expect(iso(deriveBillingCycles(rows, broken, { now: at("2026-10-08T14:30:00Z"), price })[0]!.start)).toBe("2026-09-08T21:06:19.000Z");
});

test("after a declared end, readings of another plan are a run of their own", () => {
  const rows = [declared("pro", "2026-08-01", "2026-09-01"), observed("pro", "2026-08-20T00:00:00Z", "2026-09-20T00:00:00Z"),
    observed("max-5x", "2026-09-20T00:00:00Z", null, "2026-10-15T00:00:00Z")];
  const cycles = deriveBillingCycles(rows, [], { now: at("2026-10-15T00:00:00Z"), price });
  expect(brief(cycles).map((row) => row.slice(0, 4))).toEqual([
    ["2026-08-01T00:00", "2026-09-01T00:00", "pro", "declared"],
    ["2026-09-20T00:00", "2026-10-20T00:00", "max-5x", "observed"],
  ]);
});

test("one plan at a time: a later reading of another plan ends an open declared plan (29.10)", () => {
  // Claude B on 24.10: Max 20x until the morning, then "pro" declared without an end, then readings of 20x again.
  const rows = [declared("max-20x", "2026-09-24T09:55:57.164Z", "2026-10-24T09:55:57.164Z", { amountMinor: 11378, currency: "EUR" }),
    declared("pro", "2026-10-24T12:47:00Z", null),
    observed("default_claude_ai", "2026-10-24T12:55:18Z", "2026-10-24T14:06:34.705Z"),
    observed("max-20x", "2026-10-24T14:16:34.923Z", null, "2026-10-29T07:03:58Z")];
  const cycles = brief(deriveBillingCycles(rows, [], { now: at("2026-10-29T08:00:00Z"), price })).map((row) => row.slice(0, 4));
  expect(cycles).toEqual([
    ["2026-09-24T09:55", "2026-10-24T09:55", "max-20x", "declared"],
    ["2026-10-24T12:47", "2026-10-24T14:16", "pro", "declared"],
    ["2026-10-24T14:16", "2026-11-24T14:16", "max-20x", "observed"],
  ]);
  // A reading of the same plan (in its provider spelling) does not end the declaration.
  expect(brief(deriveBillingCycles(rows.slice(1, 3), [], { now: at("2026-10-29T08:00:00Z"), price })).map((row) => [row[2], row[3], row[1]]))
    .toEqual([["pro", "declared", "2026-11-24T12:47"]]);
});
