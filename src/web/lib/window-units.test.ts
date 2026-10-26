import { describe, expect, test } from "bun:test";
import type { CreditFundedSums, WindowAtLimit } from "../../shared/credit-funded";
import { dailyUnitValues, readChartUnit, windowCapacity, windowUnitSeries, writeChartUnit, type UnitBlock, type UnitInput } from "./window-units";

const HOUR = 3_600_000;
const start = Date.parse("2026-09-26T18:00:00.000Z"), span = 168 * HOUR;
const iso = (hours: number) => new Date(start + hours * HOUR).toISOString();
/** Four 42-hour blocks of 100 tokens, $1 and 20 credits each. */
const blocks: UnitBlock[] = [0, 42, 84, 126].map(from => ({ start_ts: iso(from), end_ts: iso(from + 42), tokens: 100, usd: 1, credits: 20 }));
const atLimit: WindowAtLimit = { ts: iso(84), percent: 100, events: 9, tokens: 300, api_standard: 3, api_unpriced: 0, credits: 60, credits_unpriced: 0,
  joint_api_standard: 3, joint_credits: 60 };
const funded: CreditFundedSums = { calls: 2, tokens: 50, credits: 10, credits_unpriced: 0, api_standard: 0.5, api_unpriced: 0,
  first: iso(100), last: iso(101.5), hours: [[iso(100), 1, 20, 4, 0.2], [iso(101), 1, 30, 6, 0.3]] };
const input = (fields: Partial<UnitInput> = {}): UnitInput => ({ startMs: start, spanMs: span, blocks, usedPercent: 100, atLimit, creditFunded: null,
  windowTokens: 400, nowMs: start + 200 * HOUR, ...fields });

describe("window chart units", () => {
  test("the course is the cumulative counted sum of the stored blocks, in each unit", () => {
    const tokens = windowUnitSeries("tokens", input({ atLimit: null, usedPercent: 50 }))!;
    // Without a limit reading the estimate is value so far ÷ meter percent × 100, drawn on the 100% line.
    expect(tokens.limit).toEqual({ value: 800, estimate: true, t: null });
    expect(tokens.course).toEqual([{ t: 0, pct: 0 }, { t: 25, pct: 12.5 }, { t: 50, pct: 25 }, { t: 75, pct: 37.5 }, { t: 100, pct: 50 }]);
    expect(windowUnitSeries("credits", input({ atLimit: null, usedPercent: 50 }))!.limit!.value).toBe(160);
    expect(windowUnitSeries("usd", input({ atLimit: null, usedPercent: 50 }))!.limit!.value).toBe(8);
  });

  test("a window that reached the limit takes its capacity at the first 100% reading, exact", () => {
    const series = windowUnitSeries("credits", input())!;
    expect(series.limit).toEqual({ value: 60, estimate: false, t: 50 });
    expect(series.scale).toBe(60);
    expect(series.course!.at(-1)).toEqual({ t: 100, pct: 80 / 60 * 100 });
  });

  test("an open window stops at now and estimates its capacity from the current percent", () => {
    const open = windowUnitSeries("tokens", input({ atLimit: null, usedPercent: 40, nowMs: start + 60 * HOUR }))!;
    // Two blocks have started; the second ends at now.
    expect(open.course).toHaveLength(3);
    expect(open.course!.at(-1)!.t).toBeCloseTo(60 / 168 * 100, 9);
    expect(open.limit).toEqual({ value: 200 / 40 * 100, estimate: true, t: null });
  });

  test("the main curve excludes extra usage in every unit; daily funded bars retain their values", () => {
    for (const unit of ["pct", "tokens", "usd", "credits"] as const)
      expect(windowUnitSeries(unit, input({ creditFunded: funded }))).toEqual(windowUnitSeries(unit, input()));
    const day = [{ key: "funded", startMs: start + 96 * HOUR, endMs: start + 120 * HOUR }];
    expect(dailyUnitValues("credits", day, input({ creditFunded: funded }), [], null).get("funded")!.credit).toBe(10);
    expect(dailyUnitValues("tokens", day, input({ creditFunded: funded }), [], null).get("funded")!.credit).toBe(50);
    expect(dailyUnitValues("usd", day, input({ creditFunded: funded }), [], null).get("funded")!.credit).toBe(0.5);
    expect(dailyUnitValues("pct", day, input({ creditFunded: funded }), [], null).get("funded")!.credit).toBeCloseTo(50 / 300 * 100);
  });

  test("unpriced blocks mark the line as a lower bound; no blocks yet → no series", () => {
    expect(windowUnitSeries("usd", input({ blocks: [{ ...blocks[0]!, usd_partial: true }] }))!.partial).toBe(true);
    // A stored answer from before credits were summed per block has none: that is missing, not zero.
    expect(windowUnitSeries("credits", input({ blocks: [{ ...blocks[0]!, credits: undefined }] }))!.partial).toBe(true);
    expect(windowUnitSeries("tokens", input({ blocks: null }))).toBeNull();
  });

  test("the choice is remembered per viewer and survives a storage failure", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); } } });
    try {
      expect(readChartUnit()).toBe("pct");
      writeChartUnit("credits");
      expect(readChartUnit()).toBe("credits");
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
      expect(readChartUnit()).toBe("pct");
      expect(() => writeChartUnit("usd")).not.toThrow();
    } finally { Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }); }
  });
  test("capacity at 100% is the chart's limit, with the 1 pp rounding range for an estimate", () => {
    expect(windowCapacity("credits", input())).toEqual({ value: 60, estimate: false, partial: false, range: null });
    // 80 credits so far at 40%: 200 at 100%, 80 ÷ 41..39 × 100 with the reading 1 pp off.
    const open = windowCapacity("credits", input({ atLimit: null, usedPercent: 40 }))!;
    expect(open.value).toBe(200);
    expect(open.range!.low).toBeCloseTo(8000 / 41, 9);
    expect(open.range!.high).toBeCloseTo(8000 / 39, 9);
    // A meter at 2% or less gives no estimate; unpriced calls make the value a lower bound.
    expect(windowCapacity("usd", input({ atLimit: null, usedPercent: 2 }))).toBeNull();
    expect(windowCapacity("usd", input({ atLimit: { ...atLimit, api_unpriced: 1 } }))!.partial).toBe(true);
  });
});

describe("dailyUnitValues", () => {
  const days = [0, 24, 48].map(from => ({ key: iso(from).slice(0, 10), startMs: start + from * HOUR, endMs: start + (from + 24) * HOUR }));
  const at = (hours: number) => hours / 168 * 100;
  test("bars follow the unit: meter rise, counted tokens and block value shared by overlap", () => {
    const meter = [{ t: 0, pct: 0 }, { t: at(24), pct: 10 }, { t: at(36), pct: 16 }];
    const pctDays = dailyUnitValues("pct", days, input({ nowMs: start + 40 * HOUR }), meter, null);
    expect(pctDays.get(days[0]!.key)!.value).toBeCloseTo(10);
    // The second day counts up to the newest reading only; the third has none.
    expect(pctDays.get(days[1]!.key)!.value).toBeCloseTo(6);
    expect(pctDays.get(days[2]!.key)!.value).toBeNull();
    const tokens = dailyUnitValues("tokens", days, input(), meter, new Map([[days[1]!.key, 70]]));
    expect([...tokens.values()].map(day => day.value)).toEqual([null, 70, null]);
    // The first 42-hour block ($1) falls 24/42 on day one and 18/42 on day two; day two also has 6 h of the next.
    const usd = dailyUnitValues("usd", days, input({ nowMs: start + 168 * HOUR }), meter, null);
    expect(usd.get(days[0]!.key)!.value).toBeCloseTo(24 / 42);
    expect(usd.get(days[1]!.key)!.value).toBeCloseTo(18 / 42 + 6 / 42);
    expect(dailyUnitValues("usd", days, input({ blocks: null }), meter, null).get(days[0]!.key)!.value).toBeNull();
  });
});


test("preview dollar bars use exact daily buckets and separately saved credit hours",()=>{
  const days=[{key:iso(0).slice(0,10),startMs:start,endMs:start+24*HOUR},{key:iso(24).slice(0,10),startMs:start+24*HOUR,endMs:start+48*HOUR}];
  const exact=input({dailyUsd:new Map([[days[0]!.key,{usd:3}],[days[1]!.key,{usd:7,usd_partial:true}]]),
    creditFunded:{...funded,hours:[[iso(1),1,20,4,0.8]]}});
  const usd=dailyUnitValues("usd",days,exact,[],null);
  expect(usd.get(days[0]!.key)).toMatchObject({value:3,credit:0.8});
  expect(usd.get(days[1]!.key)).toMatchObject({value:7,partial:true});
  expect(dailyUnitValues("credits",days,exact,[],null)).toEqual(dailyUnitValues("credits",days,input({creditFunded:exact.creditFunded}),[],null));
});
