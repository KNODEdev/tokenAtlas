import { describe, expect, test } from "bun:test";
import { creditPoolsInRange, creditPoolFlows, type CreditPoolReading, type CreditPoolState } from "./credit-pools";
import { poolUsage, codexPoolEvidence, grantPoolEvidence } from "./pool-usage";
import { poolSeries, windowPoolSeries } from "../web/lib/pool-series";
import { dailyUnitValues, type UnitInput } from "../web/lib/window-units";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const state = (used: number, fields: Partial<CreditPoolState> = {}): CreditPoolState => ({ key: "grant", kind: "grant", unit: "usd",
  granted: 250, used, remaining: 250 - used, remaining_text: null, unlimited: false, granted_at: null, expires_at: at(30), items: null, ...fields });
const readings = (entries: Array<[number, number]>): CreditPoolReading[] => entries.map(([day, used]) => ({ ts: at(day), pools: [state(used)] }));
const select = (rows: CreditPoolReading[], from = 10, until = 20) => creditPoolsInRange(rows, Date.parse(at(from)), Date.parse(at(until)))!;

describe("canonical pool movements", () => {
  test("the compressed movement series reconciles to the existing flow including cross-window intervals", () => {
    const rows = readings([[9, 3], [11, 8], [12, 8], [14, 20]]), range = select(rows);
    expect(range.flows).toEqual(creditPoolFlows(rows, Date.parse(at(10)), Date.parse(at(20))));
    expect(range.timelines?.[0]).toMatchObject({ baseline_at: at(9), through: at(14), opening_known: true });
    expect(range.timelines?.[0]!.movements).toHaveLength(2);
    expect(range.timelines?.[0]!.movements[0]).toMatchObject({ since: at(9), observed_at: at(11), spent: 5 });
    const line = poolSeries(poolUsage(range), Date.parse(at(10)))[0]!;
    expect(line.points[0]!.value).toBe(0); expect(line.points.at(-1)!.value).toBe(range.flows[0]!.spent);
    expect(line.points.at(-1)!.at).toBe(at(14));
  });
  test("first reading already used is unknown opening consumption, never an invented window charge", () => {
    const range = select(readings([[11, 80], [12, 85]]));
    expect(range.flows[0]!.spent).toBe(5);
    const line = poolSeries(poolUsage(range), Date.parse(at(10)))[0]!;
    expect(line.partial).toBe(true); expect(line.points[0]).toMatchObject({ at: at(11), value: 0 });
    expect(line.points.at(-1)!.value).toBe(5);
  });
  test("zero movement is observed only up to the last reading, not through now", () => {
    const line = poolSeries(poolUsage(select(readings([[9, 80], [11, 80], [12, 80]]))), Date.parse(at(10)))[0]!;
    expect(line.points.at(-1)).toMatchObject({ at: at(12), value: 0 });
  });
  test("top-ups add balance, never spending; a missing pool is not a debit", () => {
    const rows = [{ ts: at(9), pools: [state(20)] }, { ts: at(11), pools: [state(20, { granted: 300, remaining: 280 })] }, { ts: at(12), pools: [] }];
    const range = select(rows);
    expect(range.flows[0]).toMatchObject({ spent: 0, added: 50 });
    expect(range.timelines?.[0]!.through).toBe(at(11));
    expect(poolUsage(range)[0]).toMatchObject({ state: null, kind: "grant", observedSpend: 0 });
  });
  test("separate pool identities, purchase, corrections and range changes preserve source meaning", () => {
    const rows = readings([[9, 3], [11, 8], [14, 20]]);
    rows[1]!.pools.push(state(7, { key: "purchase", kind: "purchase" }));
    rows[2]!.pools.push(state(10, { key: "purchase", kind: "purchase" }));
    const whole = select(rows), smaller = select(rows, 12);
    expect(poolUsage(whole).map(pool => [pool.key, pool.kind, pool.observedSpend])).toEqual([["grant", "grant", 17], ["purchase", "purchase", 3]]);
    expect(smaller.timelines?.[0]!.movements[0]).toEqual(whole.timelines?.[0]!.movements[1]);
    const corrected = rows.map(row => ({ ...row, pools: row.pools.map(pool => pool.key === "grant" && row.ts === at(11) ? { ...pool, used: 10, remaining: 240 } : pool) }));
    expect(select(corrected).flows[0]!.spent).toBe(17);
    expect(select(corrected).timelines?.[0]!.movements.map(step => step.spent)).toEqual([7, 10]);
    expect(JSON.stringify(select(corrected))).toBe(JSON.stringify(select(corrected)));
  });
  test("old payloads leave the timeline unavailable instead of producing a zero curve", () => {
    const range = select(readings([[9, 0], [11, 5]])); delete range.timelines;
    expect(poolUsage(range)[0]).toMatchObject({ timeline: null, observedSpend: 5 });
    expect(poolSeries(poolUsage(range), Date.parse(at(10)))).toEqual([]);
  });
  test("Codex valued funded hours are not account charges or lifetime usage", () => {
    const evidence = codexPoolEvidence({ calls: 2, tokens: 50, credits: 10, credits_unpriced: 1, api_standard: 0.5, api_unpriced: 0,
      first: at(11), last: at(12), hours: [[at(11), 1, 20, 4, 0.2], [at(12), 1, 30, 6, 0.3]] })!;
    const range = select([{ ts: at(9), pools: [state(0, { key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: 100 })] },
      { ts: at(11), pools: [state(0, { key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: 98 })] }]);
    const usage = poolUsage(range, evidence);
    expect(usage[0]).toMatchObject({ observedSpend: 2, funded: { native: 10 }, state: { used: null } });
    const lines = poolSeries(usage, Date.parse(at(10)));
    expect(lines.map(line => [line.basis, line.points[0]!.value, line.points.at(-1)!.value])).toEqual([["observed", 0, 2], ["funded", 0, 10]]);
    expect(lines[1]!.partial).toBe(true);
    expect(poolUsage(null, evidence)[0]!.observedSpend).toBeNull();
  });
  test("native credit and dollar observations have the same series geometry, without API or token inference", () => {
    const dollars = select(readings([[9, 0], [11, 5], [12, 10]]));
    const credits = select(readings([[9, 0], [11, 5], [12, 10]]).map(row => ({ ...row, pools: row.pools.map(pool => ({ ...pool, unit: "credits" as const })) })));
    expect(poolSeries(poolUsage(dollars), Date.parse(at(10)))[0]!.points).toEqual(poolSeries(poolUsage(credits), Date.parse(at(10)))[0]!.points);
    expect(poolUsage(dollars)[0]!.funded).toBeNull();
  });
  test("unreadable observations never become zero usage or extend the curve beyond evidence", () => {
    const rows = readings([[9, 0], [11, 5]]);
    rows.push({ ts: at(12), pools: [state(0, { used: null, remaining: null })] });
    const selected = select(rows);
    expect(selected.timelines?.[0]).toMatchObject({ through: at(11), complete: false });
    expect(poolSeries(poolUsage(selected), Date.parse(at(10)))[0]!.points.at(-1)!.at).toBe(at(11));
    expect(select([{ ts: at(11), pools: [state(0, { used: null, remaining: null })] }]).timelines).toEqual([]);
    rows.push({ ts: at(13), pools: [state(10)] });
    expect(select(rows).flows[0]!.spent).toBe(10);
    expect(select(rows).timelines?.[0]!.movements.at(-1)).toMatchObject({ since: at(11), observed_at: at(13), spent: 5 });
  });
  test("purchased usage and a simultaneous top-up retain both independent movements", () => {
    const selected = select([{ ts: at(9), pools: [state(25, { kind: "purchase", granted: 100, remaining: 75 })] },
      { ts: at(11), pools: [state(30, { kind: "purchase", granted: 200, remaining: 170 })] }]);
    expect(selected.flows[0]).toMatchObject({ spent: 5, added: 100 });
    expect(selected.timelines?.[0]!.movements[0]).toMatchObject({ spent: 5, added: 100 });
  });
  test("a reset used counter leaves an explicit lower bound rather than inventing consumption", () => {
    const selected = select(readings([[9, 10], [11, 30], [12, 5]]));
    expect(selected.flows[0]!.spent).toBe(20);
    expect(poolSeries(poolUsage(selected), Date.parse(at(10)))[0]).toMatchObject({ partial: true });
  });
  test("Claude grant-funded hours draw when and how much on the listed dollar grant, valued at API Standard", () => {
    const sums = { calls: 3, tokens: 900, credits: 0, credits_unpriced: 3, api_standard: 60, api_unpriced: 0,
      first: at(11), last: at(12), hours: [[at(11), 2, 600, 0, 40], [at(12), 1, 300, 0, 20]] as Array<[string, number, number, number, number]> };
    const range = select(readings([[9, 10], [13, 70]]));
    const evidence = grantPoolEvidence(sums, range)!;
    expect(evidence).toMatchObject({ poolKey: "grant", unit: "usd", kind: "grant", native: 60, apiUsd: 60 });
    const input: UnitInput = { startMs: Date.parse(at(10)), spanMs: 7 * 86_400_000, pools: range, usedPercent: 50, atLimit: null,
      creditFunded: null, fundedPool: evidence, windowTokens: 10_000, nowMs: Date.parse(at(14)),
      blocks: [{ start_ts: at(10), end_ts: at(14), tokens: 10_000, usd: 500 }] };
    const usd = windowPoolSeries(poolUsage(range, evidence), "usd", input).find(row => row.basis === "funded")!;
    expect(usd.points.map(point => [point.at, point.value])).toEqual([[at(10), 0], [at(11), 0], [new Date(Date.parse(at(11)) + 3_600_000).toISOString(), 40],
      [at(12), 40], [new Date(Date.parse(at(12)) + 3_600_000).toISOString(), 60]]);
    // "%": the window's API dollars at 100% (500 at 50% → 1000), not its tokens.
    const percent = windowPoolSeries(poolUsage(range, evidence), "pct", input).find(row => row.basis === "funded")!;
    expect(percent).toMatchObject({ value: 6, estimate: true, unavailable: null });
    const days = [{ key: "11", startMs: Date.parse(at(11)) - 43_200_000, endMs: Date.parse(at(11)) + 43_200_000 },
      { key: "12", startMs: Date.parse(at(12)) - 43_200_000, endMs: Date.parse(at(12)) + 43_200_000 }];
    const bars = dailyUnitValues("pct", days, input, [{ t: 0, pct: 0 }, { t: 50, pct: 50 }], null);
    expect([bars.get("11")!.credit, bars.get("12")!.credit]).toEqual([4, 2]);
    expect(dailyUnitValues("usd", days, input, [], null).get("11")!.credit).toBe(40);
  });
  test("Claude grant hours without one listed dollar grant keep a grant pool of their own", () => {
    const sums = { calls: 1, tokens: 10, credits: 0, credits_unpriced: 1, api_standard: 2, api_unpriced: 1,
      first: at(11), last: at(11), hours: [[at(11), 1, 10, 0, 2]] as Array<[string, number, number, number, number]> };
    expect(grantPoolEvidence(null, null)).toBeNull();
    const usage = poolUsage(null, grantPoolEvidence(sums, null));
    expect(usage).toMatchObject([{ key: "claude:grant", kind: "grant", unit: "usd", state: null, funded: { nativeUnpriced: 1 } }]);
    const input: UnitInput = { startMs: Date.parse(at(10)), spanMs: 7 * 86_400_000, usedPercent: 50, atLimit: null, creditFunded: null,
      windowTokens: 10, blocks: [{ start_ts: at(10), end_ts: at(12), tokens: 10, usd: 5, usd_partial: true }], nowMs: Date.parse(at(14)) };
    // A lower-bound dollar capacity cannot set the rate: "%" uses the window's tokens at 100% (10 at 50% → 20); dollars stay a lower bound.
    expect(windowPoolSeries(usage, "pct", input)[0]).toMatchObject({ value: 50, estimate: true, unavailable: null });
    expect(windowPoolSeries(usage, "usd", input)[0]).toMatchObject({ value: 2, partial: true });
  });
});
