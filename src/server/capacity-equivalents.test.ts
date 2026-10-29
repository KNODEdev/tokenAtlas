import { hasAnalysisSchema, installAnalysisTracking } from "../db/analysis";
import { prepareProviderReaderFacts as prepareSubscriptionFacts } from "./provider-reader.fixture";
import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEraIndex } from "./eras";
import {
  computeSeatTime,
  isCalibrationOverlapping,
  computeCapacityFromCycles,
  evaluateGaugeQuality,
  GAUGE_QUALITY_MIN_SAMPLES,
  GAUGE_QUALITY_MIN_SPAN_PP,
  buildHourlyCostIndex,
  calibrationCoverage,
  measureSlidingWindowCapacity,
  measureSlidingWindowForPeriod,
  spentBetween,
  computeEquivalentsAndProvenance,
  buildSubscriptionCapacities,
  rateCardMonthlyOf,
  resolveCodexCapacities,
  indexSubscriptionHomes,
  currentSubscriptionHomes,
  SubscriptionHomeConflictError,
  type Provenance as ServerProvenance,
  type Equivalent as ServerEquivalent,
  type EquivalentAbsentReason,
  type SubscriptionCapacity,
  type CapacityBasis as ServerCapacityBasis,
  EQUIVALENT_PUBLISHED_KEYS as SERVER_EQUIVALENT_KEYS,
  EQUIVALENT_ABSENT_REASONS as SERVER_EQUIVALENT_ABSENT_REASONS,
} from "./capacity-equivalents";
import { buildProjectCost as readProjectCost, type ProjectCostResponse } from "./project-cost";
import { buildRepoHistory as readRepoHistory } from "./repo-history";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import type { RateCard } from "./pricing";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";
import { round2 } from "./pricing";
import { Database } from "../db/sqlite";
import { ARCHIVE_LOGICAL_ROOT, REPO_ROOT, resolveArchiveRootFromEnv, resolveConfigRootFromEnv } from "../config/paths";
import { createFetchHandler, handleProjectCost, handleSetupSave, type AppContext } from "./api";
import {
  PROVENANCE_PUBLISHED_KEYS,
  EQUIVALENT_PUBLISHED_KEYS,
  EQUIVALENT_ABSENT_REASONS as WEB_EQUIVALENT_ABSENT_REASONS,
  type Provenance as WebProvenance,
  type Equivalent as WebEquivalent,
  type EquivalentAbsentReason as WebEquivalentAbsentReason,
} from "../web/lib/api";
import * as setup from "./setup";
import { declareCodexEraPeriods, type CodexEraFixture } from "./codex-periods.fixture";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { loadPlansCatalog } from "./plans-catalog";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

/** A Codex archive folder of the test archive root, the source an account period names. */
const codexFolder = (name: string) => path.join(ARCHIVE_LOGICAL_ROOT, "codex", name);
/** The home map of `subscriptions`, with each one's era declared as an account period of its source (stage 4, W6). */
function codexHomes(db: Database, subscriptions: CodexEraFixture[]): Map<string, string> {
  declareCodexEraPeriods(db, subscriptions.map((sub) => ({ vendor: "codex", ...sub })));
  return indexSubscriptionHomes(subscriptions);
}

/** Publish the synthetic events with the exact card selected by each read. */
function fixtureCodexCard(card: RateCard): RateCard {
  if (card.codex_ledger_policy || card.codex_accounting) return card;
  const models=Object.entries(card.vendors.openai?.models??{});
  const provenance={verified_at:'2026-01-01',sources:['https://example.test/capacity-fixture'],confidence:'user' as const};
  const policy:CodexLedgerPolicy={version:1,tiers:['standard','fast'],
    mappings:[{id:'fixture-default',raw_value:'default',tier:'standard'},{id:'fixture-priority',raw_value:'priority',tier:'fast'}],
    base_rules:models.map(([model,rates])=> {
      const synthetic=rates as typeof rates & {in_cache_write_5m?:number;in_cache_write_1h?:number};
      const cacheWrite=rates.in_cache_write ?? (synthetic.in_cache_write_5m===synthetic.in_cache_write_1h?synthetic.in_cache_write_5m:undefined);
      return {id:'fixture-api-'+model,model,billing_basis:'api_equivalent_usd' as const,
      valid_from:'2020-01-01',multiplier:'1',...provenance,rates:{in_uncached:String(rates.in_uncached),
        in_cache_read:String(rates.in_cache_read),out_total:String(rates.out_total),
        ...(cacheWrite!==undefined?{in_cache_write:String(cacheWrite)}:{})}};}),
    tier_rules:models.flatMap(([model])=>['standard','fast'].map(tier=>({id:'fixture-api-'+model+'-'+tier,
      model,billing_basis:'api_equivalent_usd' as const,tier,valid_from:'2020-01-01',multiplier:tier==='standard'?'1':'2',...provenance})))};
  return {...card,codex_ledger_policy:policy};
}
function buildProjectCost(...args: Parameters<typeof readProjectCost>): ProjectCostResponse {
  const [db,,homes] = args,card=fixtureCodexCard(args[1]);
  if ((db.query("PRAGMA table_info(events)").all() as {name:string}[]).some(column=>column.name==='ts'))
    prepareCodexLedgerFixture(db,card,homes);
  // Gemini and OpenCode evidence comes from the shared usage ledger the maintenance worker fills.
  installFactDayRevisions(db);
  fillUsageLedgerFixture(db,card,["gemini","glm"]);
  return readProjectCost(db,card,homes,args[3]);
}
function buildRepoHistory(...args: Parameters<typeof readRepoHistory>): ReturnType<typeof readRepoHistory> {
  const [db,options]=args;
  const card=options.rateCards?fixtureCodexCard(options.rateCards):undefined;
  if (card && (db.query("PRAGMA table_info(events)").all() as {name:string}[]).some(column=>column.name==='ts'))
    prepareCodexLedgerFixture(db,card,options.homeToSubId);
  return readRepoHistory(db,{...options,rateCards:card});
}

function prepareProviderProjectFacts(db: Database, cards: Parameters<typeof buildProjectCost>[1]): void {
  if (!hasAnalysisSchema(db))
    createAnalysisSourceRevisions(db);
  installAnalysisTracking(db);
  for (const [provider, table] of [["claude", "claude_events"], ["gemini", "gemini_events"], ["grok", "grok_events"], ["glm", "oc_events"]] as const) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as {name: string}[];
    if (!columns.some(column => column.name === "store")) continue;
    const stores=db.query(`SELECT DISTINCT store FROM ${table} WHERE store IS NOT NULL`).all() as {store:string}[];
    for (const {store} of stores.length?stores:[{store:provider}]) {
      let steps = 0;
      while (!prepareSubscriptionFacts(db, provider, store, undefined, 100, cards).complete)
        if (++steps > 100) throw new Error("Synthetic provider preparation did not finish");
    }
  }
}
type PublishedProvenanceKey = (typeof PROVENANCE_PUBLISHED_KEYS)[number];
type SameKeys<T, Published extends PropertyKey> = Exclude<keyof T, Published> extends never
  ? Exclude<Published, keyof T> extends never
    ? true
    : never
  : never;
const _webProvenanceKeys: SameKeys<WebProvenance, PublishedProvenanceKey> = true;
const _serverProvenanceKeys: SameKeys<ServerProvenance, PublishedProvenanceKey> = true;
void _webProvenanceKeys;
void _serverProvenanceKeys;
type PublishedEquivalentKey = (typeof EQUIVALENT_PUBLISHED_KEYS)[number];
const _webEquivalentKeys: SameKeys<WebEquivalent, PublishedEquivalentKey> = true;
const _serverEquivalentKeys: SameKeys<ServerEquivalent, PublishedEquivalentKey> = true;
const _equivalentKeysMatch: SameKeys<
  ServerEquivalent,
  (typeof SERVER_EQUIVALENT_KEYS)[number]
> = true;
void _webEquivalentKeys;
void _serverEquivalentKeys;
void _equivalentKeysMatch;
type MutualExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssignsTo<A, B> = [A] extends [B] ? true : false;
const _equivalentShapeParity: MutualExtends<ServerEquivalent, WebEquivalent> = true;
const _presentBranchParity: MutualExtends<
  Extract<ServerEquivalent, { absent: null }>,
  Extract<WebEquivalent, { absent: null }>
> = true;
const _absentBranchParity: MutualExtends<
  Extract<ServerEquivalent, { value: null }>,
  Extract<WebEquivalent, { value: null }>
> = true;
const _absentReasonParity: MutualExtends<EquivalentAbsentReason, WebEquivalentAbsentReason> = true;
const _absentReasonConstParity: MutualExtends<
  (typeof SERVER_EQUIVALENT_ABSENT_REASONS)[number],
  (typeof WEB_EQUIVALENT_ABSENT_REASONS)[number]
> = true;
void _equivalentShapeParity;
void _presentBranchParity;
void _absentBranchParity;
void _absentReasonParity;
void _absentReasonConstParity;
const _rejectPresentWithReason: AssignsTo<
  { value: number; absent: EquivalentAbsentReason },
  ServerEquivalent
> = false;
const _rejectNullNull: AssignsTo<{ value: null; absent: null }, ServerEquivalent> = false;
const _acceptPresent: AssignsTo<{ value: number; absent: null }, ServerEquivalent> = true;
const _acceptAbsent: AssignsTo<{ value: null; absent: EquivalentAbsentReason }, ServerEquivalent> = true;
const _rejectPresentWithReasonWeb: AssignsTo<
  { value: number; absent: WebEquivalentAbsentReason },
  WebEquivalent
> = false;
const _rejectNullNullWeb: AssignsTo<{ value: null; absent: null }, WebEquivalent> = false;
void _rejectPresentWithReason;
void _rejectNullNull;
void _acceptPresent;
void _acceptAbsent;
void _rejectPresentWithReasonWeb;
void _rejectNullNullWeb;
function publishedProvenanceKeySet(): string[] {
  return [...PROVENANCE_PUBLISHED_KEYS].sort();
}
function assertSerializedProvenanceKeys(provenance: object, label: string): void {
  expect({ label, keys: Object.keys(provenance).sort() }).toEqual({
    label,
    keys: publishedProvenanceKeySet(),
  });
}
function publishedEquivalentKeySet(): string[] {
  return [...EQUIVALENT_PUBLISHED_KEYS].sort();
}
function assertSerializedEquivalentKeys(eq: object, label: string): void {
  expect({ label, keys: Object.keys(eq).sort() }).toEqual({
    label,
    keys: publishedEquivalentKeySet(),
  });
}
function expectEquivalent(
  eq: ServerEquivalent,
  value: number | null,
  absent: EquivalentAbsentReason | null
): void {
  expect(eq.value).toBe(value);
  expect(eq.absent).toBe(absent);
  assertSerializedEquivalentKeys(JSON.parse(JSON.stringify(eq)) as object, `equivalent:${absent ?? value}`);
}
describe("Equivalent contract parity", () => {
  it("server and web share the Equivalent type shape and exhaustive absent-reason union", () => {
    expect([...SERVER_EQUIVALENT_ABSENT_REASONS].sort()).toEqual([...WEB_EQUIVALENT_ABSENT_REASONS].sort());
    expect([...SERVER_EQUIVALENT_KEYS].sort()).toEqual([...EQUIVALENT_PUBLISHED_KEYS].sort());
  });
});
describe("measureSlidingWindowCapacity", () => {
  const HOUR = 3_600_000;
  const flat = (n: number, usd: number) =>
    Array.from({ length: n }, (_, i) => ({
      hour: new Date(Date.parse("2026-01-01T00:00:00Z") + i * HOUR).toISOString().slice(0, 13),
      usd,
    }));
  const at = (hourIndex: number) =>
    new Date(Date.parse("2026-01-01T00:00:00Z") + hourIndex * HOUR).toISOString();
  it("reads the allowance straight off the definition of a rolling window", () => {
    const cost = buildHourlyCostIndex(flat(400, 10));
    const samples = Array.from({ length: 40 }, (_, i) => ({ ts: at(200 + i), used_percent: 50 }));
    const res = measureSlidingWindowCapacity(cost, samples, 168);
    expect(res.usd_per_point).toBeCloseTo(33.6, 1);
    expect(res.window_value_usd).toBeCloseTo(3360, 0);
  });
  it("drops a sample whose lookback reaches before the indexed traffic", () => {
    const cost = buildHourlyCostIndex(flat(400, 10));
    const early = measureSlidingWindowCapacity(cost, [{ ts: at(100), used_percent: 50 }], 168);
    expect(early.basis).toBe("none");
    expect(early.sample_count).toBe(0);
    const late = measureSlidingWindowCapacity(cost, [{ ts: at(300), used_percent: 50 }], 168);
    expect(late.sample_count).toBe(1);
  });
  it("ignores readings too low to divide by", () => {
    const cost = buildHourlyCostIndex(flat(400, 10));
    const low = measureSlidingWindowCapacity(cost, [{ ts: at(300), used_percent: 5 }], 168);
    expect(low.basis).toBe("none");
    expect(measureSlidingWindowCapacity(cost, [{ ts: at(300), used_percent: 25 }], 168).sample_count).toBe(1);
  });
  it("calls it measured only when the samples are many AND spread over more than one window", () => {
    const cost = buildHourlyCostIndex(flat(900, 10));
    const clustered = Array.from({ length: 40 }, (_, i) => ({ ts: at(300 + i), used_percent: 50 }));
    expect(measureSlidingWindowCapacity(cost, clustered, 168).basis).toBe("single");
    const spread = Array.from({ length: 40 }, (_, i) => ({ ts: at(200 + i * 15), used_percent: 50 }));
    expect(measureSlidingWindowCapacity(cost, spread, 168).basis).toBe("measured");
  });
  it("answers nothing rather than zero when there is no traffic or no sample", () => {
    expect(measureSlidingWindowCapacity(buildHourlyCostIndex([]), [{ ts: at(300), used_percent: 50 }], 168).basis).toBe("none");
    expect(measureSlidingWindowCapacity(buildHourlyCostIndex(flat(400, 10)), [], 168).window_value_usd).toBeNull();
    expect(measureSlidingWindowCapacity(buildHourlyCostIndex(flat(400, 10)), [{ ts: at(300), used_percent: 50 }], 0).basis).toBe("none");
  });
  it("stamps the calibration with the span of the samples it actually used", () => {
    const cost = buildHourlyCostIndex(flat(900, 10));
    const spread = Array.from({ length: 40 }, (_, i) => ({ ts: at(200 + i * 15), used_percent: 50 }));
    const res = measureSlidingWindowCapacity(cost, spread, 168);
    expect(res.start_ts).toBe(at(200));
    expect(res.end_ts).toBe(at(200 + 39 * 15));
  });
  it("with a period uses only samples inside it, ignoring a different spend outside", () => {
    const cheap = flat(400, 10);
    const expensive = Array.from({ length: 400 }, (_, i) => ({
      hour: at(400 + i).slice(0, 13),
      usd: 100,
    }));
    const cost = buildHourlyCostIndex([...cheap, ...expensive]);
    const cheapSamples = Array.from({ length: 40 }, (_, i) => ({ ts: at(200 + i), used_percent: 50 }));
    const expensiveSamples = Array.from({ length: 40 }, (_, i) => ({ ts: at(500 + i), used_percent: 50 }));
    const samples = [...cheapSamples, ...expensiveSamples];
    const scoped = measureSlidingWindowCapacity(cost, samples, 168, { until: "2026-01-12" });
    const cheapOnly = measureSlidingWindowCapacity(cost, cheapSamples, 168);
    const all = measureSlidingWindowCapacity(cost, samples, 168);
    expect(scoped.sample_count).toBe(cheapOnly.sample_count);
    expect(scoped.usd_per_point).toBe(cheapOnly.usd_per_point);
    expect(scoped.window_value_usd).toBe(cheapOnly.window_value_usd);
    expect(all.sample_count).toBeGreaterThan(scoped.sample_count);
    expect(all.usd_per_point).not.toBe(scoped.usd_per_point);
    const picked = measureSlidingWindowForPeriod(cost, samples, 168, { until: "2026-01-12" });
    expect(picked.usd_per_point).toBe(scoped.usd_per_point);
    expect(picked.note).toBe(
      `okno przesuwne: mediana z ${scoped.sample_count} odczytów licznika w wybranym okresie (wydatek z ostatnich 168 h wobec procentu)`
    );
  });
  it("still spends the 168 h lookback from before the period start", () => {
    const cost = buildHourlyCostIndex(flat(192, 10));
    const res = measureSlidingWindowCapacity(cost, [{ ts: at(250), used_percent: 50 }], 168, {
      since: "2026-01-09",
    });
    expect(res.sample_count).toBe(1);
    expect(res.usd_per_point).toBeCloseTo(22, 1);
    expect(res.window_value_usd).toBeCloseTo(2200, 0);
  });
  it("too few samples in the period falls back to all history and says so", () => {
    const cost = buildHourlyCostIndex(flat(400, 10));
    const inPeriod = Array.from({ length: 5 }, (_, i) => ({ ts: at(200 + i), used_percent: 50 }));
    const outside = Array.from({ length: 40 }, (_, i) => ({ ts: at(300 + i), used_percent: 50 }));
    const samples = [...inPeriod, ...outside];
    const period = { since: "2026-01-09", until: "2026-01-09" };
    const scoped = measureSlidingWindowCapacity(cost, samples, 168, period);
    expect(scoped.sample_count).toBe(5);
    const all = measureSlidingWindowCapacity(cost, samples, 168);
    const picked = measureSlidingWindowForPeriod(cost, samples, 168, period);
    expect(picked.sample_count).toBe(all.sample_count);
    expect(picked.usd_per_point).toBe(all.usd_per_point);
    expect(picked.window_value_usd).toBe(all.window_value_usd);
    expect(picked.note).toBe(
      `okno przesuwne: mediana z ${all.sample_count} odczytów licznika z całej historii, bo w wybranym okresie za mało próbek (wydatek z ostatnich 168 h wobec procentu)`
    );
  });
  it("omitting period gives the same numbers as the unfiltered measurement", () => {
    const cost = buildHourlyCostIndex(flat(400, 10));
    const samples = Array.from({ length: 40 }, (_, i) => ({ ts: at(200 + i), used_percent: 50 }));
    const a = measureSlidingWindowCapacity(cost, samples, 168);
    expect(measureSlidingWindowCapacity(cost, samples, 168, undefined)).toEqual(a);
    expect(measureSlidingWindowCapacity(cost, samples, 168, {})).toEqual(a);
    expect(a.usd_per_point).toBeCloseTo(33.6, 1);
    expect(a.window_value_usd).toBeCloseTo(3360, 0);
    const picked = measureSlidingWindowForPeriod(cost, samples, 168);
    expect(picked.usd_per_point).toBe(a.usd_per_point);
    expect(picked.window_value_usd).toBe(a.window_value_usd);
    expect(picked.sample_count).toBe(a.sample_count);
    expect(picked.note).toBe(
      `okno przesuwne: mediana z ${a.sample_count} odczytów licznika (wydatek z ostatnich 168 h wobec procentu)`
    );
  });
});
describe("spentBetween", () => {
  it("sums the half-open interval and never runs off either end", () => {
    const cost = buildHourlyCostIndex([
      { hour: "2026-01-01T00", usd: 5 },
      { hour: "2026-01-01T01", usd: 7 },
      { hour: "2026-01-01T02", usd: 11 },
    ]);
    const ms = (h: number) => Date.parse(`2026-01-01T0${h}:00:00Z`);
    expect(spentBetween(cost, ms(0), ms(3))).toBe(23);
    expect(spentBetween(cost, ms(1), ms(2))).toBe(7);
    expect(spentBetween(cost, ms(0), ms(0))).toBe(0);
    expect(spentBetween(cost, ms(5), ms(9))).toBe(0);
  });
  it("orders the buckets it was handed, so an unsorted feed still sums right", () => {
    const cost = buildHourlyCostIndex([
      { hour: "2026-01-01T02", usd: 11 },
      { hour: "2026-01-01T00", usd: 5 },
      { hour: "2026-01-01T01", usd: 7 },
    ]);
    expect(spentBetween(cost, Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T02:00:00Z"))).toBe(12);
  });
});
describe("calibrationCoverage", () => {
  const cap = (start: string | null, end: string | null, basis: ServerCapacityBasis = "measured") => ({
    calibration_start_ts: start,
    calibration_end_ts: end,
    capacity_basis: basis,
  });
  it("is full only when the calibration contains the whole range", () => {
    expect(calibrationCoverage(cap("2026-08-01", "2026-08-31"), "2026-08-05", "2026-08-20")).toEqual({
      kind: "full",
      share: 1,
    });
    expect(calibrationCoverage(cap("2026-08-05", "2026-08-20"), "2026-08-05", "2026-08-20").kind).toBe("full");
  });
  it("is partial when the calibration only reaches part of the range, and says how much", () => {
    const late = calibrationCoverage(cap("2026-02-09", "2026-08-17"), "2026-07-28", "2026-08-27");
    expect(late.kind).toBe("partial");
    expect(late.share).toBeCloseTo(21 / 31, 3);
    const early = calibrationCoverage(cap("2026-08-16", "2026-08-30"), "2026-07-28", "2026-08-27");
    expect(early.kind).toBe("partial");
    expect(early.share).toBeCloseTo(12 / 31, 3);
  });
  it("is none for disjoint periods, an open period, a missing calibration and no capacity", () => {
    expect(calibrationCoverage(cap("2026-08-01", "2026-08-31"), "2025-01-01", "2025-01-31")).toEqual({
      kind: "none",
      share: 0,
    });
    expect(calibrationCoverage(cap("2026-08-01", "2026-08-31"), "2026-08-05", null).kind).toBe("none");
    expect(calibrationCoverage(cap("2026-08-01", "2026-08-31"), null, "2026-08-20").kind).toBe("none");
    expect(calibrationCoverage(cap(null, null), "2026-08-05", "2026-08-20").kind).toBe("none");
    expect(calibrationCoverage(cap("2026-08-01", "2026-08-31", "none"), "2026-08-05", "2026-08-20").kind).toBe("none");
  });
  it("touching by a single day is partial, not none", () => {
    const touch = calibrationCoverage(cap("2026-07-01", "2026-08-01"), "2026-08-01", "2026-08-31");
    expect(touch.kind).toBe("partial");
    expect(touch.share).toBeCloseTo(1 / 31, 3);
  });
});
describe("Pure capacity equivalents & provenance", () => {
  describe("Seat time calculation", () => {
    it("computes months and weeks accurately from billed_usd and declared monthly price", () => {
      const res = computeSeatTime(100, 200);
      expect(res).not.toBeNull();
      expect(res?.months).toBe(0.5);
      expect(res?.weeks).toBe(2.1743);
    });
    it("returns null when declared monthly price is missing, null, or zero", () => {
      expect(computeSeatTime(100, null)).toBeNull();
      expect(computeSeatTime(100, undefined)).toBeNull();
      expect(computeSeatTime(100, 0)).toBeNull();
      expect(computeSeatTime(100, -20)).toBeNull();
    });
    it("handles zero billed_usd with non-zero price as 0 months and 0 weeks", () => {
      const res = computeSeatTime(0, 200);
      expect(res).not.toBeNull();
      expect(res?.months).toBe(0);
      expect(res?.weeks).toBe(0);
    });
  });
  describe("Calibration coverage detection", () => {
    const calib = {
      calibration_start_ts: "2026-08-18T00:00:00Z",
      calibration_end_ts: "2026-08-25T23:59:59Z",
      capacity_basis: "measured" as const,
    };
    it("returns true when calibration covers the entire query period", () => {
      expect(isCalibrationOverlapping(calib, "2026-08-19", "2026-08-24")).toBe(true);
      expect(isCalibrationOverlapping(calib, "2026-08-18", "2026-08-25")).toBe(true);
    });
    it("returns false when query period is not covered by calibration window", () => {
      expect(isCalibrationOverlapping(calib, "2026-08-01", "2026-08-31")).toBe(false);
      expect(isCalibrationOverlapping(calib, "2025-09-01", "2025-09-30")).toBe(false);
      expect(isCalibrationOverlapping(calib, "2026-07-01", "2026-07-31")).toBe(false);
      expect(isCalibrationOverlapping(calib, "2026-09-01", "2026-09-30")).toBe(false);
    });
    it("returns false when since or until is omitted instead of inheriting calibration bounds", () => {
      expect(isCalibrationOverlapping(calib, "2026-08-19", undefined)).toBe(false);
      expect(isCalibrationOverlapping(calib, "2026-08-19", null)).toBe(false);
      expect(isCalibrationOverlapping(calib, undefined, "2026-08-24")).toBe(false);
      expect(isCalibrationOverlapping(calib, null, null)).toBe(false);
    });
    it("returns false when capacity_basis is none or calibration bounds are missing", () => {
      expect(
        isCalibrationOverlapping(
          { calibration_start_ts: null, calibration_end_ts: null, capacity_basis: "none" },
          "2026-08-01",
          "2026-08-31"
        )
      ).toBe(false);
      expect(
        isCalibrationOverlapping(
          { calibration_start_ts: "2026-08-01", calibration_end_ts: "2026-08-31", capacity_basis: "none" },
          "2026-08-05",
          "2026-08-10"
        )
      ).toBe(false);
    });
  });
  describe("Capacity from cycles distribution", () => {
    it("requires MIN_PP_FOR_RATE >= 20, MIN_GAUGE_SAMPLES >= 20, MIN_CALLS >= 100", () => {
      const lowPp = [{ usedPercent: 10, sample_count: 50, calls: 200, usd: 50 }];
      expect(computeCapacityFromCycles(lowPp).basis).toBe("none");
      const lowSamples = [{ usedPercent: 50, sample_count: 5, calls: 200, usd: 50 }];
      expect(computeCapacityFromCycles(lowSamples).basis).toBe("none");
      const lowCalls = [{ usedPercent: 50, sample_count: 50, calls: 10, usd: 50 }];
      expect(computeCapacityFromCycles(lowCalls).basis).toBe("none");
    });
    it("labels multiple qualifying closed cycles as 'measured' with median rate", () => {
      const cycles = [
        { usedPercent: 100, sample_count: 50, calls: 500, usd: 2800, start_ts: "2026-08-01", end_ts: "2026-08-07" },
        { usedPercent: 100, sample_count: 50, calls: 500, usd: 3000, start_ts: "2026-08-08", end_ts: "2026-08-14" },
        { usedPercent: 100, sample_count: 50, calls: 500, usd: 2900, start_ts: "2026-08-15", end_ts: "2026-08-21" },
      ];
      const res = computeCapacityFromCycles(cycles);
      expect(res.basis).toBe("measured");
      expect(res.usd_per_point).toBe(29);
      expect(res.window_value_usd).toBe(2900);
      expect(res.start_ts).toBe("2026-08-01");
      expect(res.end_ts).toBe("2026-08-21");
    });
    it("labels a single qualifying cycle as 'single'", () => {
      const cycles = [
        { usedPercent: 100, sample_count: 50, calls: 500, usd: 200, start_ts: "2026-08-01", end_ts: "2026-08-07" },
      ];
      const res = computeCapacityFromCycles(cycles);
      expect(res.basis).toBe("single");
      expect(res.usd_per_point).toBe(2);
      expect(res.window_value_usd).toBe(200);
    });
  });
  describe("per-window gauge quality (plan-capacity first gate)", () => {
    it("rejects below 50 samples or 20 pp and keeps medium/high bands above that floor", () => {
      expect(GAUGE_QUALITY_MIN_SAMPLES).toBe(50);
      expect(GAUGE_QUALITY_MIN_SPAN_PP).toBe(20);
      expect(
        evaluateGaugeQuality({ sample_count: 49, first_percent: 0, peak_percent: 80, lag_fraction: 0.01, distinct_steps: 70 })
          .accepted
      ).toBe(false);
      expect(
        evaluateGaugeQuality({ sample_count: 80, first_percent: 0, peak_percent: 19, lag_fraction: 0.01, distinct_steps: 70 })
          .confidence
      ).toBe("none");
      const medium = evaluateGaugeQuality({
        sample_count: 60,
        first_percent: 0,
        peak_percent: 55,
        lag_fraction: 0.1,
        distinct_steps: 35,
      });
      expect(medium.accepted).toBe(true);
      expect(medium.confidence).toBe("medium");
      const high = evaluateGaugeQuality({
        sample_count: 90,
        first_percent: 0,
        peak_percent: 90,
        lag_fraction: 0.02,
        distinct_steps: 70,
      });
      expect(high.confidence).toBe("high");
    });
  });
  describe("Equivalents & Provenance non-negotiables", () => {
    const claudeCapWithout5h: SubscriptionCapacity = {
      sub_id: "claude",
      vendor: "claude",
      plan: "max-20x",
      usd_per_month: 200,
      usd_per_point: 2.406,
      weekly_window_value_usd: 240.6,
      session_window_value_usd: null,
      window_hours: 168,
      session_hours: null,
      capacity_basis: "single",
      price_basis: "rate-card",
      cadence: "declared",
      calibration_start_ts: "2026-08-01",
      calibration_end_ts: "2026-08-31",
    };
    const claudeCapWithMeasured5h: SubscriptionCapacity = {
      sub_id: "claude",
      vendor: "claude",
      plan: "max-20x",
      usd_per_month: 200,
      usd_per_point: 34.579,
      weekly_window_value_usd: 3457.9,
      session_window_value_usd: 328.52,
      window_hours: 168,
      session_hours: 5,
      capacity_basis: "single",
      price_basis: "rate-card",
      cadence: "declared",
      calibration_start_ts: "2026-08-01",
      calibration_end_ts: "2026-08-31",
    };
    const grokCap: SubscriptionCapacity = {
      sub_id: "grok",
      vendor: "grok",
      plan: "xai",
      usd_per_month: null,
      usd_per_point: 1.5,
      weekly_window_value_usd: 150.0,
      session_window_value_usd: null,
      window_hours: 168,
      session_hours: null,
      capacity_basis: "single",
      price_basis: "none",
      cadence: "declared",
      calibration_start_ts: "2026-08-01",
      calibration_end_ts: "2026-08-31",
    };
    const geminiCap: SubscriptionCapacity = {
      sub_id: "gemini",
      vendor: "gemini",
      plan: null,
      usd_per_month: null,
      usd_per_point: null,
      weekly_window_value_usd: null,
      session_window_value_usd: null,
      window_hours: null,
      session_hours: null,
      capacity_basis: "none",
      price_basis: "none",
      cadence: "probe",
      calibration_start_ts: null,
      calibration_end_ts: null,
    };
    it("returns null full_5h_sessions when 5h window is not independently calibrated", () => {
      const res = computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(res.equivalents.weekly_cycles, 0.5, null);
      expectEquivalent(res.equivalents.full_5h_sessions, null, "cadence_uncalibrated");
      expect(res.provenance.capacity).toBe("single");
      expect(res.provenance.price).toBe("rate-card");
      expect(res.provenance.cadence).toBe("declared");
      expect(res.provenance.calibration_covers_period).toBe(true);
    });
    it("returns full_5h_sessions when independently calibrated", () => {
      const res = computeEquivalentsAndProvenance(328.52, claudeCapWithMeasured5h, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(res.equivalents.full_5h_sessions, 1.0, null);
      expectEquivalent(res.equivalents.weekly_cycles, 0.095, null);
    });
    it("emits price_basis: 'none' for Grok (tick scale without rate card)", () => {
      const res = computeEquivalentsAndProvenance(75.0, grokCap, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(res.equivalents.weekly_cycles, 0.5, null);
      expectEquivalent(res.equivalents.full_5h_sessions, null, "cadence_uncalibrated");
      expect(res.provenance.price).toBe("none");
      expect(res.provenance.capacity).toBe("single");
      expect(res.provenance.calibration_covers_period).toBe(true);
    });
    it("returns NULL (not 0) when capacity basis is none (e.g. Gemini)", () => {
      const res = computeEquivalentsAndProvenance(100.0, geminiCap, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(res.equivalents.full_5h_sessions, null, "no_capacity");
      expectEquivalent(res.equivalents.weekly_cycles, null, "no_capacity");
      expect(res.provenance.capacity).toBe("none");
      expect(res.provenance.price).toBe("none");
      expect(res.provenance.calibration_covers_period).toBe(false);
    });
    it("returns NULL (not 0) when calibration does not cover the query period", () => {
      const res = computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, {
        since: "2025-01-01",
        until: "2025-01-31",
      });
      expectEquivalent(res.equivalents.full_5h_sessions, null, "period_uncovered");
      expectEquivalent(res.equivalents.weekly_cycles, null, "period_uncovered");
      expect(res.provenance.calibration_covers_period).toBe(false);
    });
    it("returns NULL when until is omitted so coverage cannot be claimed of an open period", () => {
      const res = computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, {
        since: "2026-08-05",
      });
      expectEquivalent(res.equivalents.weekly_cycles, null, "period_uncovered");
      expectEquivalent(res.equivalents.full_5h_sessions, null, "period_uncovered");
      expect(res.provenance.calibration_covers_period).toBe(false);
    });
    it("returns ZERO equivalents for finite zero usage with valid denominators and coverage", () => {
      const zeroWeekly = computeEquivalentsAndProvenance(0, claudeCapWithout5h, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(zeroWeekly.equivalents.weekly_cycles, 0, null);
      expectEquivalent(zeroWeekly.equivalents.full_5h_sessions, null, "cadence_uncalibrated");
      expect(zeroWeekly.provenance.calibration_covers_period).toBe(true);
      const zeroBoth = computeEquivalentsAndProvenance(0, claudeCapWithMeasured5h, {
        since: "2026-08-05",
        until: "2026-08-20",
      });
      expectEquivalent(zeroBoth.equivalents.weekly_cycles, 0, null);
      expectEquivalent(zeroBoth.equivalents.full_5h_sessions, 0, null);
      expect(zeroBoth.provenance.calibration_covers_period).toBe(true);
    });
    it("a single equivalent's absent reason is recoverable without sibling fields", () => {
      const cadence = computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, coveredPeriod);
      expectEquivalent(cadence.equivalents.full_5h_sessions, null, "cadence_uncalibrated");
      const uncovered = computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, {
        since: "2025-01-01",
        until: "2025-01-31",
      });
      expectEquivalent(uncovered.equivalents.full_5h_sessions, null, "period_uncovered");
      const none = computeEquivalentsAndProvenance(100, geminiCap, coveredPeriod);
      expectEquivalent(none.equivalents.full_5h_sessions, null, "no_capacity");
    });
    const coveredPeriod = { since: "2026-08-05", until: "2026-08-20" };
    const provenanceExits: Array<{
      name: string;
      run: () => ReturnType<typeof computeEquivalentsAndProvenance>;
      covers: boolean;
      weekly: { value: number | null; absent: EquivalentAbsentReason | null };
      sessions: { value: number | null; absent: EquivalentAbsentReason | null };
    }> = [
      {
        name: "null capacity",
        run: () => computeEquivalentsAndProvenance(100, null, coveredPeriod),
        covers: false,
        weekly: { value: null, absent: "no_capacity" },
        sessions: { value: null, absent: "no_capacity" },
      },
      {
        name: "capacity_basis none",
        run: () => computeEquivalentsAndProvenance(100, geminiCap, coveredPeriod),
        covers: false,
        weekly: { value: null, absent: "no_capacity" },
        sessions: { value: null, absent: "no_capacity" },
      },
      {
        name: "uncovered period",
        run: () =>
          computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, {
            since: "2025-01-01",
            until: "2025-01-31",
          }),
        covers: false,
        weekly: { value: null, absent: "period_uncovered" },
        sessions: { value: null, absent: "period_uncovered" },
      },
      {
        name: "invalid apiUsd (NaN, covered period)",
        run: () => computeEquivalentsAndProvenance(Number.NaN, claudeCapWithout5h, coveredPeriod),
        covers: true,
        weekly: { value: null, absent: "invalid_usage" },
        sessions: { value: null, absent: "invalid_usage" },
      },
      {
        name: "invalid apiUsd (negative, covered period)",
        run: () => computeEquivalentsAndProvenance(-1, claudeCapWithout5h, coveredPeriod),
        covers: true,
        weekly: { value: null, absent: "invalid_usage" },
        sessions: { value: null, absent: "invalid_usage" },
      },
      {
        name: "covered happy path",
        run: () => computeEquivalentsAndProvenance(120.3, claudeCapWithout5h, coveredPeriod),
        covers: true,
        weekly: { value: 0.5, absent: null },
        sessions: { value: null, absent: "cadence_uncalibrated" },
      },
    ];
    it("factory: coverage is assigned only inside makeProvenance", () => {
      const src = fs.readFileSync(path.join(import.meta.dir, "capacity-equivalents.ts"), "utf8");
      const factory = src.split("export function computeEquivalentsAndProvenance")[1]?.split("\nexport function")[0];
      expect(factory).toBeDefined();
      expect(factory).not.toMatch(/calibration_covers_period/);
      expect(factory).toContain("makeProvenance(");
      const helper = src.split("function makeProvenance")[1]?.split("\nexport function")[0];
      expect(helper).toBeDefined();
      expect(helper).toMatch(/calibration_covers_period\s*:/);
      expect(src.match(/calibration_covers_period\s*:/g)).toHaveLength(2);
    });
    for (const exit of provenanceExits) {
      it(`factory exit "${exit.name}": coverage value; boundary: serialized own keys match contract`, () => {
        const res = exit.run();
        expect(res.provenance.calibration_covers_period).toBe(exit.covers);
        expectEquivalent(res.equivalents.weekly_cycles, exit.weekly.value, exit.weekly.absent);
        expectEquivalent(res.equivalents.full_5h_sessions, exit.sessions.value, exit.sessions.absent);
        const serialized = JSON.parse(JSON.stringify(res.provenance)) as Record<string, unknown>;
        assertSerializedProvenanceKeys(serialized, exit.name);
      });
    }
  });
});
describe("Integration & Regression against SQLite fixtures", () => {
  const rateCards = {
    version: 2,
    currency: "USD",
    unit: "USD per 1,000,000 tokens",
    vendors: {
      xai: { models: {
        grok: { in_uncached: 1, in_cache_read: 1, in_cache_write: 1, out_total: 1 },
        "grok-4": { in_uncached: 100, in_cache_read: 100, in_cache_write: 100, out_total: 100 },
      } },
      openai: {
        models: {
          "gpt-4o": {
            in_uncached: 2.5,
            in_cache_read: 1.25,
            in_cache_write_5m: 2.5,
            in_cache_write_1h: 2.5,
            out_total: 10.0,
          },
        },
      },
      anthropic: {
        models: {
          "claude-3-5-sonnet-20241022": {
            in_uncached: 3.0,
            in_cache_read: 0.3,
            in_cache_write_5m: 3.75,
            in_cache_write_1h: 6.0,
            out_total: 15.0,
          },
        },
      },
    },
    subscriptions: {
      codex1: { plan: "pro", usd_per_month: 200 },
      claude: { plan: "max-20x", usd_per_month: 200 },
    },
  };
  // The local profile copies the archive folder of codex1, whose account period the test database declares.
  const CODEX1_FOLDER = codexFolder("TEST-codex1");
  const homeToSubId = indexSubscriptionHomes([{ id: "codex1", home: "C:/Users/test/.codex" }, { id: "claude", home: "C:/Users/test/.claude" }],
    [{ vendor: "codex", home: CODEX1_FOLDER, source_home: "C:/Users/test/.codex" }]);
  const PRE_REQ_SUBSCRIPTION_KEYS = [
    "id",
    "vendor",
    "plan",
    "usd_per_month",
    "api_usd",
    "attributed_usd",
    "first_day",
    "last_day",
    "days",
    "paid_usd",
    "basis",
  ] as const;
  const PRE_REQ_SUBJECT_KEYS = ["subject", "kind", "id", "api_usd", "billed_usd", "calls", "by_sub"] as const;
  const PRE_REQ_TOTALS_KEYS = [
    "api_usd",
    "paid_usd",
    "billed_usd",
    "unassigned_billed_usd",
    "unassigned_api_usd",
  ] as const;
  function pickKeys<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
    const out = {} as Pick<T, K>;
    for (const key of keys) out[key] = obj[key];
    return out;
  }
  function projectPreReqCostFields(res: ProjectCostResponse) {
    return {
      since: res.since,
      until: res.until,
      subscriptions: res.subscriptions.map((s) => pickKeys(s, PRE_REQ_SUBSCRIPTION_KEYS)),
      subjects: res.subjects.map((s) => pickKeys(s, PRE_REQ_SUBJECT_KEYS)),
      totals: pickKeys(res.totals, PRE_REQ_TOTALS_KEYS),
      unpriced: res.unpriced,
      notes: res.notes,
    };
  }
  const PRE_REQ_PROJECT_COST_BASELINE_JSON = JSON.stringify({
    since: "2026-08-01",
    until: "2026-08-31",
    subscriptions: [
      {
        id: "claude",
        vendor: "claude",
        plan: null,
        usd_per_month: 200,
        api_usd: 4.5,
        attributed_usd: 4.5,
        first_day: "2026-08-12",
        last_day: "2026-08-12",
        days: 1,
        paid_usd: 6.57,
        basis: "rate-card",
      },
      {
        id: "codex1",
        vendor: "codex",
        plan: null,
        usd_per_month: 200,
        api_usd: 3.5,
        attributed_usd: 3.5,
        first_day: "2026-08-10",
        last_day: "2026-08-10",
        days: 1,
        paid_usd: 6.57,
        basis: "rate-card",
      },
    ],
    subjects: [
      {
        subject: "p:my-app",
        kind: "project",
        id: "my-app",
        api_usd: 8,
        billed_usd: 13.14,
        calls: 2,
        by_sub: { codex1: 3.5, claude: 4.5 },
      },
    ],
    totals: {
      api_usd: 8,
      paid_usd: 13.14,
      billed_usd: 13.14,
      unassigned_billed_usd: 0,
      unassigned_api_usd: 0,
    },
    unpriced: { tokens: 0, models: {} },
    notes: [
      "billed_usd to udzial w RACHUNKU, liczony osobno w kazdej subskrypcji i sumowany. api_usd to ceny cennika API - ile ten sam ruch kosztowalby bez abonamentu. To dwie rozne liczby i nie wolno ich mieszac.",
      "Mianownikiem udzialu jest CALY ruch subskrypcji, wiec udzialy projektow nie sumuja sie do rachunku. Reszta stoi w unassigned_billed_usd.",
      "gemini nie jest reprezentowany: gemini_events wiezie nazwe workspace'u, nie katalog roboczy, wiec zadne zdarzenie nie ma przypisania do projektu.",
      "Rachunek rozlicza sie proporcjonalnie do dni (usd_per_month * dni / 30.44), tak samo jak /api/leverage.",
    ],
  });
  function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE events (
        ts TEXT,
        home TEXT,
        repo TEXT,
        project_id TEXT,
        model TEXT,
        in_tok INTEGER,
        cached_in INTEGER,
        cache_write INTEGER,
        out_tok INTEGER,
        reasoning_out INTEGER,
        path TEXT,
        gap_seconds REAL
      );
      CREATE TABLE claude_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL,
        ts TEXT,
        repo TEXT,
        project_id TEXT,
        model TEXT,
        speed TEXT,
        in_uncached INTEGER,
        in_cache_read INTEGER,
        cache_write_5m INTEGER,
        cache_write_1h INTEGER,
        in_cache_write INTEGER,
        out_total INTEGER,
        session_id TEXT,
        store TEXT,
        subscription_id TEXT,
        subscription_conflict INTEGER NOT NULL DEFAULT 0,
        gap_seconds REAL
      );
      CREATE TABLE oc_events (
        id INTEGER PRIMARY KEY, store TEXT DEFAULT 'opencode', message_id TEXT DEFAULT 'message',
        ts TEXT,
        repo TEXT,
        project_id TEXT,
        model TEXT,
        provider TEXT,
        directory TEXT,
        in_tok INTEGER,
        cache_read INTEGER,
        cache_write INTEGER,
        out_tok INTEGER,
        session_id TEXT,
        cost_ticks INTEGER,
        gap_seconds REAL
      );
      CREATE TABLE grok_events (
        id INTEGER PRIMARY KEY, prompt_id TEXT DEFAULT 'prompt',
        ts TEXT,
        repo TEXT,
        project_id TEXT,
        model TEXT,
        in_tok INTEGER,
        cached_in INTEGER,
        cache_write INTEGER,
        out_tok INTEGER,
        reasoning INTEGER,
        cost_ticks INTEGER,
        session_id TEXT,
        store TEXT,
        gap_seconds REAL
      );
      CREATE TABLE gemini_events (
        id INTEGER PRIMARY KEY,
        ts TEXT,
        fresh_in INTEGER,
        cached_in INTEGER,
        out_total INTEGER,
        conversation_id TEXT,
        store TEXT
      );
      CREATE TABLE ratelimit (
        ts TEXT,
        home TEXT,
        window_minutes INTEGER,
        limit_id TEXT,
        resets_at REAL,
        used_percent REAL,
        plan_type TEXT,
        limit_name TEXT,
        path TEXT
      );
    `);
    declareCodexEraPeriods(db, [{ id: "codex1", vendor: "codex", home: CODEX1_FOLDER }]);
    createAnalysisSourceRevisions(db);
    installAnalysisTracking(db);
    while(!prepareSubscriptionFacts(db,"claude","claude",undefined,100,rateCards as never).complete) {}
    return db;
  }
  function prepareClaudeProjectCostFacts(db: Database, cards: Parameters<typeof buildProjectCost>[1] = rateCards as never): void {
    if (!hasAnalysisSchema(db)) {
      createAnalysisSourceRevisions(db);
    }
    installAnalysisTracking(db);
    let steps = 0;
    while (!prepareSubscriptionFacts(db, "claude", "claude", undefined, 100,cards).complete) {
      if (++steps > 100) throw new Error("Synthetic Claude facts did not finish bounded preparation");
    }
  }
  function buildPreparedProjectCost(...args: Parameters<typeof buildProjectCost>): ProjectCostResponse {
    prepareClaudeProjectCostFacts(args[0],args[1]);
    prepareProviderProjectFacts(args[0],args[1]);
    return buildProjectCost(...args);
  }
  function handlePreparedProjectCost(
    ctx: AppContext,
    request: Parameters<typeof handleProjectCost>[1],
  ): ReturnType<typeof handleProjectCost> {
    prepareClaudeProjectCostFacts(ctx.sqlite,ctx.rateCards);
    ctx={...ctx,rateCards:fixtureCodexCard(ctx.rateCards)};
    prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,ctx.homeToSubId);
    return handleProjectCost(ctx, request);
  }
  it("project costs count Grok cached input and reasoning only once and include OpenCode reasoning", () => {
    const db = createTestDb();
    try {
      db.exec("ALTER TABLE oc_events ADD COLUMN reasoning INTEGER");
      installAnalysisTracking(db);
      db.exec(`INSERT INTO grok_events(ts,repo,project_id,model,in_tok,cached_in,cache_write,out_tok,reasoning,cost_ticks,store,session_id)
        VALUES ('2026-08-10T12:00:00Z','repo','grok-project','grok',100,40,5,30,20,1000,'grok','session');
        INSERT INTO oc_events(ts,repo,project_id,model,provider,in_tok,cache_read,cache_write,out_tok,reasoning)
        VALUES ('2026-08-10T12:00:00Z','repo','oc-project','glm-test','zai',100,40,5,30,20)`);
      const cards = {...rateCards,vendors:{...rateCards.vendors,zai:{models:{'glm-test':{in_uncached:1,in_cache_read:1,in_cache_write:1,out_total:1}}}}};
      prepareProviderProjectFacts(db,cards as never);
      const result=buildProjectCost(db,cards as never,homeToSubId,{since:'2026-08-01',until:'2026-08-31'});
      expect(result.subjects.find(row=>row.id==='grok-project')?.tokens).toBe(135);
      expect(result.subjects.find(row=>row.id==='oc-project')?.tokens).toBe(195);
    } finally { db.close(); }
  });
  it("project costs count only the selected days of two years of traffic", () => {
    const db = createTestDb();
    try {
      const put=db.query("INSERT INTO grok_events(ts,repo,project_id,model,in_tok,cached_in,cache_write,out_tok,reasoning,cost_ticks,store,session_id,prompt_id) VALUES (?,'repo','project','grok',100,40,5,30,20,1000,'grok','session',?)");
      for(let index=0;index<730;index++)put.run(new Date(Date.parse('2024-08-02')+index*86400000).toISOString(),String(index));
      const opts={since:'2026-07-29',until:'2026-07-31'};
      prepareProviderProjectFacts(db,rateCards as never);
      const expected=buildProjectCost(db,rateCards as never,homeToSubId,opts);
      expect(buildProjectCost(db,rateCards as never,homeToSubId,opts)).toEqual(expected);
      expect(expected.subjects.find(row=>row.id==='project')?.tokens).toBe(405);
    } finally {db.close();}
  });
  it("keeps Grok's declared monthly price separate from its vendor-tick API valuation", () => {
    const db = createTestDb();
    const cards = {
      ...rateCards,
      subscriptions: {
        ...rateCards.subscriptions,
        grok: { plan: "SuperGrok", usd_per_month: 30 },
      },
    };
    const caps = buildSubscriptionCapacities(db, cards as never, homeToSubId, {
      claudeGauge: {},
      grokGauge: { subscription: "grok", store: "grok", plan: "xai", window_hours: 168 },
    });
    const grok = caps.get("grok");
    expect(grok?.plan).toBeNull();
    expect(grok?.usd_per_month).toBe(30);
    expect(grok?.price_basis).toBe("rate-card");
  });
  it("gives a plan cost the same rate-card fallback as the capacity rows, without measuring them", () => {
    const db = createTestDb();
    try {
      const grokGauge = { subscription: "grok-acct", store: "grok-acct", plan: "xai", window_hours: 168 };
      const cards = { ...rateCards, subscriptions: { codex1: { usd_per_month: 200 }, unpriced: { plan: "x" }, grok: { usd_per_month: 30 } } };
      const ids = ["codex1", "unpriced", "grok-acct", "nobody"];
      const caps = buildSubscriptionCapacities(db, cards as never, homeToSubId, { claudeGauge: {}, grokGauge, subscriptions: ids });
      for (const id of ids) expect(rateCardMonthlyOf(db, cards as never, id, { grokGauge })).toBe(caps.get(id)?.usd_per_month ?? null);
      expect(rateCardMonthlyOf(db, cards as never, "grok-acct", { grokGauge })).toBe(30);
      expect(rateCardMonthlyOf(db, cards as never, "unpriced", { grokGauge })).toBeNull();
    } finally { db.close(); }
  });
  it("does not calibrate legacy Codex closed cycles without speed evidence", () => {
    const db = createTestDb();
    const anchor1 = 1786363200;
    const anchor2 = 1786363201;
    for (let s = 0; s < 25; s++) {
      const anchor = s % 2 === 0 ? anchor1 : anchor2;
      db.run(`
        INSERT INTO ratelimit (ts, home, window_minutes, limit_id, resets_at, used_percent, path)
        VALUES ('2026-08-04T12:${String(s).padStart(2, "0")}:00Z', 'C:\\Users\\test\\.codex', 10080, 'codex', ${anchor}, 100, 'sess-1');
      `);
    }
    for (let i = 0; i < 120; i++) {
      db.run(`
        INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
        VALUES ('2026-08-05T12:00:00Z', 'C:\\Users\\test\\.codex', 'my-repo', 'my-app', 'gpt-4o', 10000, 0, 0, 1000, 0, 'sess-1');
      `);
    }
    const caps = resolveCodexCapacities(
      db,
      rateCards as any,
      homeToSubId,
      rateCards.subscriptions as any
    );
    const codex1 = caps.get("codex1");
    expect(codex1).toBeDefined();
    expect(codex1?.capacity_basis).toBe("none");
    expect(codex1?.weekly_window_value_usd).toBeNull();
  });
  it("indexes both archive home and declared source_home onto the same subscription id", () => {
    const db = createTestDb();
    const map = codexHomes(db, [{ id: "codex1", home: codexFolder("EXAMPLE-MAIN-sample_a"), source_home: "C:\\Users\\test\\.codex" }]);
    expect(map.get(codexFolder("EXAMPLE-MAIN-sample_a").replaceAll("\\", "/").toLowerCase())).toBe("codex1");
    expect(map.get("c:/users/test/.codex")).toBe("codex1");
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'C:\\Users\\test\\.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-live');
    `);
    const res = buildProjectCost(db, rateCards as never, map, { since: "2026-08-01", until: "2026-08-31" });
    const app = res.subjects.find((s) => s.id === "my-app");
    expect(app?.subscriptions["codex1"]).toBeDefined();
    expect(app?.subscriptions["codex?"]).toBeUndefined();
    expect(res.subscriptions.some((s) => s.id === "codex?")).toBe(false);
    expect(app?.subscriptions["codex1"]?.calls).toBe(1);
    expect(app?.by_sub).toEqual({ codex1: 3.5 });
  });
  it("rejects conflicting normalized home declarations instead of last-write-wins", () => {
    expect(() =>
      indexSubscriptionHomes([
        { id: "codex1", home: "C:\\Users\\a\\.codex" },
        { id: "codex2", home: "C:/Users/a/.codex" },
      ])
    ).toThrow(/conflicting subscription home/);
  });
  it("maps a home that changed subscription between eras to the era covering now", () => {
    const home = "H:\\archive\\codex\\EXAMPLE-MAIN-sample_b";
    const eras = [{ id: "codex2", home, until: "2026-09-01" }, { id: "codex3", home, from: "2026-09-01" }];
    expect(() => indexSubscriptionHomes(eras)).toThrow(/conflicting subscription home/);
    expect([...currentSubscriptionHomes(eras, "2026-09-20T00:00:00.000Z").values()]).toEqual(["codex3"]);
    expect([...currentSubscriptionHomes(eras, "2026-08-20T00:00:00.000Z").values()]).toEqual(["codex2"]);
    // A conflict inside one era is the server's reported state, not a producer failure.
    expect(currentSubscriptionHomes([{ id: "codex1", home }, { id: "codex2", home }]).size).toBe(0);
  });




  it("counts the complete source copy when the archive mirror is a strict prefix", () => {
    const archiveHome = codexFolder("EXAMPLE-MAIN-sample_a");
    const sourceHome = "C:\\Users\\test\\.codex";
    const db = createTestDb();
    const map = codexHomes(db, [
      { id: "codex1", home: archiveHome, source_home: sourceHome },
    ]);
    const archivePath = archiveHome + "\\sessions\\2026\\08\\10\\rollout-partial.jsonl";
    const sourcePath = sourceHome + "\\sessions\\2026\\08\\10\\rollout-partial.jsonl";
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
       VALUES ('2026-08-10T12:00:00Z', ?, 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, ?)`,
      [archiveHome, archivePath]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
       VALUES ('2026-08-10T12:00:00Z', ?, 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, ?)`,
      [sourceHome, sourcePath]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
       VALUES ('2026-08-10T18:00:00Z', ?, 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, ?)`,
      [sourceHome, sourcePath]
    );
    // Copies of one file share their records' byte offsets: the archive holds the prefix of the source copy.
    db.run("ALTER TABLE events ADD COLUMN source_offset INTEGER");
    db.run("UPDATE events SET source_offset=CASE ts WHEN '2026-08-10T12:00:00Z' THEN 0 ELSE 100 END");
    const res = buildProjectCost(db, rateCards as never, map, { since: "2026-08-01", until: "2026-08-31" });
    const app = res.subjects.find((s) => s.id === "my-app");
    expect(app?.subscriptions["codex1"]?.calls).toBe(2);
    expect(app?.subscriptions["codex1"]?.api_usd).toBe(7);
    expect(res.subscriptions.find((s) => s.id === "codex1")?.api_usd).toBe(7);
    const hist = buildRepoHistory(db, {
      repo: null,
      projectId: "my-app",
      granularity: "day",
      by: "none",
      idleGapMinutes: 15,
      since: "2026-08-01",
      until: "2026-08-31",
      rateCards: rateCards as never,
      homeToSubId: map,
    });
    expect(hist.totals.calls).toBe(2);
    expect(hist.totals.by_sub["codex1"]?.api_usd).toBe(7);
  });
  it("attributes a re-logged home's events to its account period, not the declared filesystem home", () => {
    const sample_b = codexFolder("EXAMPLE-MAIN-sample_b");
    const sample_c = codexFolder("EXAMPLE-MAIN-sample_c");
    const map = indexSubscriptionHomes([
      { id: "codex2", home: sample_b },
      { id: "codex3", home: sample_c },
    ]);
    const db = createTestDb();
    // The home's own declaration names codex2; its account period from the re-login names codex3.
    declareCodexEraPeriods(db, [
      { id: "codex2", vendor: "codex", home: sample_b, until: "2026-08-21" },
      { id: "codex3", vendor: "codex", home: sample_b, from: "2026-08-21" },
      { id: "codex3", vendor: "codex", home: sample_c },
    ]);
    const cards = {
      ...rateCards,
      subscriptions: {
        ...rateCards.subscriptions,
        codex2: { plan: "plus", usd_per_month: 20 },
        codex3: { plan: "plus", usd_per_month: 20 },
      },
    };
    const anchor = 1786363200;
    const pathY = sample_b + "\\sessions\\2026\\08\\21\\rollout-relogin.jsonl";
    const pathX = sample_c + "\\sessions\\2026\\08\\21\\rollout-orig.jsonl";
    db.run(
      `INSERT INTO ratelimit (ts, home, window_minutes, limit_id, resets_at, used_percent, path)
       VALUES ('2026-08-21T12:00:00Z', ?, 10080, 'codex', ?, 10, ?)`,
      [sample_c, anchor, pathX]
    );
    db.run(
      `INSERT INTO ratelimit (ts, home, window_minutes, limit_id, resets_at, used_percent, path)
       VALUES ('2026-08-21T17:31:00Z', ?, 10080, 'codex', ?, 40, ?)`,
      [sample_b, anchor, pathY]
    );
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
         VALUES ('2026-08-21T18:00:00Z', ?, 'stk-repo', 'stk-app', 'gpt-4o', 100000, 0, 0, 10000, 0, ?)`,
        [sample_b, pathY]
      );
    }
    const res = buildProjectCost(db, cards as never, map, { since: "2026-08-01", until: "2026-08-31" });
    const app = res.subjects.find((s) => s.id === "stk-app");
    expect(app?.subscriptions["codex3"]?.calls).toBe(10);
    expect(app?.subscriptions["codex2"]).toBeUndefined();
    expect(res.subscriptions.some((s) => s.id === "codex2")).toBe(false);
    expect(res.subscriptions.some((s) => s.id === "codex3")).toBe(true);
  });
  it("keeps project cost but withholds normalized equivalents without speed evidence", () => {
    const db = createTestDb();
    const anchor = 1786363200;
    for (let s = 0; s < 25; s++) {
      db.run(`
        INSERT INTO ratelimit (ts, home, window_minutes, limit_id, resets_at, used_percent, path)
        VALUES ('2026-08-04T12:${String(s).padStart(2, "0")}:00Z', 'C:\\Users\\test\\.codex', 10080, 'codex', ${anchor}, 100, 'sess-1');
      `);
    }
    for (let i = 0; i < 120; i++) {
      db.run(`
        INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
        VALUES ('2026-08-05T12:00:00Z', 'C:\\Users\\test\\.codex', 'my-repo', 'my-app', 'gpt-4o', 10000, 0, 0, 1000, 0, 'sess-1');
      `);
    }
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-20T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-late');
    `);
    const res = buildProjectCost(db, rateCards as never, homeToSubId, { since: "2026-08-01" });
    const app = res.subjects.find((s) => s.id === "my-app");
    const slice = app?.subscriptions["codex1"];
    expect(slice).toBeDefined();
    expect(res.until).toBeNull();
    expect(slice?.provenance.calibration_covers_period).toBe(false);
    expect(slice?.provenance.coverage).toBe("none");
    expect(slice!.provenance.measured_share).toBe(0);
    expect(slice!.api_usd).toBeGreaterThan(0);
    expect(slice!.equivalents.weekly_cycles.absent).toBe("no_capacity");
    expect(slice!.equivalents.monthly_subscriptions.absent).toBe("no_capacity");
    expect(slice!.cost_at_full_use_usd).toBeNull();
  });
  it("boundary: GET /api/project-cost serialized provenance own keys match the contract on every path", async () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (1, 'boundary-claude', '2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'sess-2', 'claude', 'claude', 0);
    `);
    const response = handlePreparedProjectCost(
      { sqlite: db, rateCards, homeToSubId, accounts: { version: 2, subscriptions: [], sources: [] } } as unknown as AppContext,
      new URL("http://127.0.0.1/api/project-cost?since=2026-08-01&until=2026-08-31")
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      subscriptions?: Array<{ id: string; provenance?: object }>;
      subjects?: Array<{ subscriptions?: Record<string, { provenance?: object }> }>;
    };
    const fromSubscriptions: Array<{ path: string; provenance: object }> = [];
    for (const sub of body.subscriptions ?? []) {
      if (sub.provenance) fromSubscriptions.push({ path: `subscriptions[${sub.id}]`, provenance: sub.provenance });
    }
    const fromSlices: Array<{ path: string; provenance: object }> = [];
    for (const [si, subject] of (body.subjects ?? []).entries()) {
      for (const [subId, slice] of Object.entries(subject.subscriptions ?? {})) {
        if (slice.provenance) fromSlices.push({ path: `subjects[${si}].subscriptions[${subId}]`, provenance: slice.provenance });
      }
    }
    expect(fromSubscriptions.length).toBeGreaterThan(0);
    expect(fromSlices.length).toBeGreaterThan(0);
    for (const item of [...fromSubscriptions, ...fromSlices]) {
      assertSerializedProvenanceKeys(item.provenance, item.path);
    }
  });
  it("never sums equivalents across subscriptions or into aggregate project totals", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (1, 'equiv-claude', '2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'sess-2', 'claude', 'claude', 0);
    `);
    const res = buildPreparedProjectCost(db, rateCards as any, homeToSubId, { since: "2026-08-01", until: "2026-08-31" });
    const app = res.subjects.find((s) => s.id === "my-app");
    expect(app).toBeDefined();
    expect((app as Record<string, unknown> | undefined)?.equivalents).toBeUndefined();
    expect((app as Record<string, unknown> | undefined)?.seat_time).toBeUndefined();
    const codexSlice = app?.subscriptions?.["codex1"];
    const claudeSlice = app?.subscriptions?.["claude"];
    expect(codexSlice).toBeDefined();
    expect(claudeSlice).toBeDefined();
    expect(codexSlice?.equivalents).toBeDefined();
    expect(claudeSlice?.equivalents).toBeDefined();
  });
  describe("plan history (account plan periods) inside the cost", () => {
    const shippedCatalog = loadPlansCatalog(path.join(import.meta.dir, "../.."));
    function dbWithSpan(periods: Array<{ value: string; from: string; until: string | null; origin?: "declared" | "observed" }> = []): Database {
      const db = createTestDb();
      for (const ts of ["2026-01-05T12:00:00Z", "2026-06-20T12:00:00Z"]) {
        db.run(
          `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
           VALUES ('${ts}', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');`
        );
      }
      db.exec(`CREATE TABLE plan_periods (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
        from_ts TEXT NOT NULL, until_ts TEXT, plan TEXT NOT NULL, amount_minor INTEGER, currency TEXT, origin TEXT NOT NULL,
        first_seen TEXT, last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
      replaceDeclaredPeriods(db, PLAN_PERIODS, periods.map((period) => ({ provider: "codex", subject: "codex1", value: period.value,
        from: period.from, until: period.until, origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" })));
      return db;
    }
    const range = { since: "2026-01-01", until: "2026-06-30" };
    it("an account without plan periods keeps the old single rate-card price, and a retired stage changes nothing", () => {
      const before = buildProjectCost(dbWithSpan(), rateCards as any, homeToSubId, range);
      const after = buildProjectCost(dbWithSpan(), rateCards as any, homeToSubId, { ...range, plansCatalog: shippedCatalog });
      expect(after.totals.paid_usd).toBe(before.totals.paid_usd);
      expect(after.subscriptions.find((s) => s.id === "codex1")?.plan).toBeNull();
      expect(after.subscriptions.find((s) => s.id === "codex1")?.plan_periods.map((p) => p.source)).toEqual(["rate-card"]);
    });
    it("bills the cheaper plan at its catalog price for the months it actually was the cheaper plan", () => {
      const naive = buildProjectCost(dbWithSpan(), rateCards as any, homeToSubId, range);
      const withHistory = buildProjectCost(dbWithSpan([
        { value: "plus", from: "2026-01-01", until: "2026-04-01" },
        { value: "pro", from: "2026-04-01", until: null },
      ]), rateCards as any, homeToSubId, { ...range, plansCatalog: shippedCatalog });
      const sub = withHistory.subscriptions.find((s) => s.id === "codex1")!;
      const naiveSub = naive.subscriptions.find((s) => s.id === "codex1")!;
      expect(sub.plan).toBe("plus → pro");
      expect(sub.plan_periods.map((p) => p.usd_per_month)).toEqual([20, 200]);
      expect(sub.usd_per_month_declared).toBe(200);
      expect(sub.usd_per_month!).toBeGreaterThan(20);
      expect(sub.usd_per_month!).toBeLessThan(200);
      expect(sub.paid_usd!).toBeLessThan(naiveSub.paid_usd! * 0.7);
      // Summed before rounding: each stretch's rounded `usd` may differ from the total by a cent.
      const fromPeriods = sub.plan_periods.reduce((a, p) => a + p.usd_per_month! * (p.days / 30.44), 0);
      expect(sub.paid_usd!).toBeCloseTo(fromPeriods, 2);
      expect(sub.plan_periods.every((p) => p.source === "declared")).toBe(true);
      expect(withHistory.totals.billed_usd + withHistory.totals.unassigned_billed_usd).toBeCloseTo(
        withHistory.totals.paid_usd,
        1
      );
    });
    it("a plan period without a catalog price leaves bill and monthly price unknown, never the rate-card price", () => {
      const res = buildProjectCost(dbWithSpan([{ value: "no-such-plan", from: "2026-02-01", until: "2026-03-01" }]),
        rateCards as any, homeToSubId, { ...range, plansCatalog: shippedCatalog });
      const sub = res.subscriptions.find((s) => s.id === "codex1")!;
      expect(sub.plan_periods.map((p) => [p.source, p.usd_per_month])).toEqual([["rate-card", null], ["declared", null], ["rate-card", null]]);
      expect(sub.paid_usd).toBeNull();
      expect(sub.usd_per_month).toBeNull();
    });
    it("marks days no plan period covers as rate-card rather than swallowing them", () => {
      const res = buildProjectCost(dbWithSpan([{ value: "plus", from: "2026-02-01", until: "2026-03-01" }]),
        rateCards as any, homeToSubId, { ...range, plansCatalog: shippedCatalog });
      const sub = res.subscriptions.find((s) => s.id === "codex1")!;
      expect(sub.plan_periods.map((p) => p.source)).toEqual(["rate-card", "declared", "rate-card"]);
      expect(res.notes.some((n) => n.includes("okresow kont"))).toBe(true);
    });
    it("project history splits the same plan-period bill as the project cost, and its buckets add up to it", () => {
      // Regression (09.10): the history priced accounts by the rate-card only, so an account priced by its
      // plan periods (every verified account of the new pipeline) had billed_usd=null in every bucket.
      const periodOnly = { ...rateCards, subscriptions: { ...rateCards.subscriptions, codex1: { plan: "pro" } } };
      const withSubjects = (periods: Parameters<typeof dbWithSpan>[0]) => {
        const db = dbWithSpan(periods);
        db.run(`INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
          VALUES ('2026-03-10T12:00:00Z', 'c:/users/test/.codex', 'other-repo', 'other-app', 'gpt-4o', 500000, 0, 0, 50000, 0, 'sess-2'),
                 ('2026-05-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'no-rate-model', 1000, 0, 0, 100, 0, 'sess-3')`);
        return db;
      };
      const read = (periods: Parameters<typeof dbWithSpan>[0], granularity: "day" | "week" | "month" = "month") => {
        const cost = buildProjectCost(withSubjects(periods), periodOnly as any, homeToSubId, { ...range, plansCatalog: shippedCatalog });
        const history = buildRepoHistory(withSubjects(periods), { repo: null, projectId: "my-app", granularity, by: "none",
          idleGapMinutes: 15, ...range, rateCards: periodOnly as any, homeToSubId, plansCatalog: shippedCatalog });
        return { cost, history, slice: cost.subjects.find((s) => s.id === "my-app")?.subscriptions.codex1 };
      };
      const covered = read([{ value: "plus", from: "2026-01-01", until: "2026-04-01" }, { value: "pro", from: "2026-04-01", until: null }]);
      expect(covered.slice?.billed_usd).toBeGreaterThan(0);
      expect(covered.history.totals.billed_usd).toBe(37.67);
      expect(covered.history.totals.by_sub.codex1?.billed_usd).toBe(covered.slice!.billed_usd);
      expect(covered.history.totals.billed_usd).toBe(covered.cost.subjects.find((s) => s.id === "my-app")!.billed_usd);
      expect(covered.history.totals.billed_complete).toBe(covered.cost.subjects.find((s) => s.id === "my-app")!.billed_complete);
      expect(covered.history.totals.billed_complete).toBe(false);
      const cents = covered.history.points.reduce((sum, p) => sum + Math.round(p.billed_usd! * 100), 0);
      expect(cents).toBe(Math.round(covered.history.totals.billed_usd! * 100));
      // The later unknown model withholds that dated split, while the earlier known subtotal survives.
      expect(covered.history.points.find((p) => p.bucket === "2026-05")?.api_complete).toBe(false);
      for (const granularity of ["day", "week"] as const) {
        const history = read([{ value: "plus", from: "2026-01-01", until: "2026-04-01" }, { value: "pro", from: "2026-04-01", until: null }], granularity).history;
        expect(history.totals.billed_usd).toBe(37.67);
        expect(round2(history.points.reduce((sum, point) => sum + (point.billed_usd ?? 0), 0))).toBe(37.67);
        expect(history.totals.billed_complete).toBe(false);
      }
      // Empty known periods contribute zero; missing prices remain explicit, with an incomplete subtotal.
      const unknown = read([{ value: "no-such-plan", from: "2026-02-01", until: "2026-03-01" }]);
      expect(unknown.slice?.billed_usd).toBe(0);
      expect(unknown.slice?.plan_periods?.some(period => period.billed_usd === null)).toBe(true);
      expect(unknown.history.totals.by_sub.codex1?.billed_usd).toBe(unknown.slice!.billed_usd);
      expect(unknown.history.totals.billed_complete).toBe(false);
    });
    it("publishes cost at full use as the monthly equivalent times the effective price", () => {
      const res = buildProjectCost(dbWithSpan(), rateCards as any, homeToSubId, range);
      const slice = res.subjects.find((s) => s.id === "my-app")?.subscriptions["codex1"];
      expect(slice).toBeDefined();
      const monthly = slice!.equivalents.monthly_subscriptions;
      if (monthly.absent == null) {
        const price = res.subscriptions.find((s) => s.id === "codex1")!.usd_per_month!;
        expect(slice!.cost_at_full_use_usd).toBeCloseTo(monthly.value * price, 1);
      } else {
        expect(slice!.cost_at_full_use_usd).toBeNull();
      }
    });
  });
  it("publishes null billed allocation for an unpriced subscription", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    const unpricedRateCards = {
      ...rateCards,
      subscriptions: { codex1: { plan: "pro" } },
    };
    const res = buildProjectCost(db, unpricedRateCards as never, homeToSubId, {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    const slice = res.subjects.find((subject) => subject.id === "my-app")?.subscriptions.codex1;
    expect(slice).toBeDefined();
    expect(slice?.api_usd).toBeGreaterThan(0);
    expect(slice?.billed_usd).toBeNull();
    expect(slice?.seat_time).toBeNull();
  });
  it("buildProjectCost subject billed is unavailable when all-null, incomplete when mixed, and numeric zero when priced", () => {
    const range = { since: "2026-08-01", until: "2026-08-31" };
    const mixedCards = {
      ...rateCards,
      subscriptions: { ...rateCards.subscriptions, grok: { plan: "super" } },
    };
    const mixed = createTestDb();
    mixed.run(`
      INSERT INTO grok_events (ts, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning, cost_ticks, session_id, store)
      VALUES ('2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'grok-4', 1000, 0, 0, 100, 0, 163230000000, 'g1', 'grok');
    `);
    mixed.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    const mixedCost = buildPreparedProjectCost(mixed, mixedCards as never, homeToSubId, range);
    const mixedSubject = mixedCost.subjects.find((s) => s.id === "my-app");
    expect(mixedSubject).toBeDefined();
    expect(mixedSubject!.subscriptions.grok?.billed_usd).toBeNull();
    expect(mixedSubject!.subscriptions.codex1?.billed_usd).not.toBeNull();
    expect(typeof mixedSubject!.subscriptions.codex1?.billed_usd).toBe("number");
    expect(mixedSubject!.billed_usd).toBe(mixedSubject!.subscriptions.codex1!.billed_usd);
    expect(mixedSubject!.billed_complete).toBe(false);
    expect(mixedSubject!.share_of_priced_spend_pct).not.toBeNull();
    expect(typeof mixedSubject!.share_of_priced_spend_pct).toBe("number");
    expect(mixedSubject!.billed_usd).not.toBeNull();
    expect(mixedCost.totals.billed_usd).toBe(mixedSubject!.billed_usd as number);
    const mixedJson = JSON.parse(JSON.stringify(mixedSubject)) as {
      billed_usd: unknown;
      billed_complete: unknown;
      share_of_priced_spend_pct: unknown;
      subscriptions: Record<string, { billed_usd: unknown }>;
    };
    expect(mixedJson.billed_usd).toBe(mixedSubject!.billed_usd);
    expect(mixedJson.billed_complete).toBe(false);
    expect(mixedJson.subscriptions.grok?.billed_usd).toBeNull();
    expect(mixedJson.subscriptions.codex1?.billed_usd).toBe(mixedSubject!.subscriptions.codex1!.billed_usd);
    const unpricedOnly = createTestDb();
    unpricedOnly.run(`
      INSERT INTO grok_events (ts, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning, cost_ticks, session_id, store)
      VALUES ('2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'grok-4', 1000, 0, 0, 100, 0, 163230000000, 'g1', 'grok');
    `);
    const unpricedCost = buildPreparedProjectCost(unpricedOnly, mixedCards as never, homeToSubId, range);
    const unpricedSubject = unpricedCost.subjects.find((s) => s.id === "my-app");
    expect(unpricedSubject).toBeDefined();
    expect(unpricedSubject!.subscriptions.grok?.billed_usd).toBeNull();
    expect(unpricedSubject!.billed_usd).toBeNull();
    expect(unpricedSubject!.billed_complete).toBe(false);
    expect(unpricedSubject!.share_of_priced_spend_pct).toBeNull();
    expect(unpricedCost.totals.non_tmp_tokens).toBe(unpricedSubject!.tokens);
    const unpricedJson = JSON.parse(JSON.stringify(unpricedSubject)) as {
      billed_usd: unknown;
      billed_complete: unknown;
      share_of_priced_spend_pct: unknown;
    };
    expect(unpricedJson.billed_usd).toBeNull();
    expect(unpricedJson.billed_complete).toBe(false);
    expect(unpricedJson.share_of_priced_spend_pct).toBeNull();
    const declaredZero = createTestDb();
    declaredZero.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    const zeroCards = {
      ...rateCards,
      subscriptions: { codex1: { plan: "pro", usd_per_month: 0 } },
    };
    const zeroCost = buildProjectCost(declaredZero, zeroCards as never, homeToSubId, range);
    const zeroSubject = zeroCost.subjects.find((s) => s.id === "my-app");
    expect(zeroSubject).toBeDefined();
    expect(zeroSubject!.subscriptions.codex1?.api_usd).toBeGreaterThan(0);
    expect(zeroSubject!.subscriptions.codex1?.billed_usd).toBe(0);
    expect(zeroSubject!.billed_usd).toBe(0);
    expect(zeroSubject!.billed_complete).toBe(true);
    const zeroJson = JSON.parse(JSON.stringify(zeroSubject)) as {
      billed_usd: unknown;
      billed_complete: unknown;
    };
    expect(zeroJson.billed_usd).toBe(0);
    expect(zeroJson.billed_complete).toBe(true);
  });
  it("buildRepoHistory echoes the exact project or repo request identity", () => {
    const db = createTestDb();
    const base = {
      granularity: "day" as const,
      by: "none" as const,
      idleGapMinutes: 15,
      rateCards: rateCards as never,
      homeToSubId,
    };
    expect(buildRepoHistory(db, { ...base, repo: null, projectId: "alpha" }).subject).toEqual({
      kind: "project",
      id: "alpha",
    });
    expect(buildRepoHistory(db, { ...base, repo: "repo-a" }).subject).toEqual({
      kind: "repo",
      id: "repo-a",
    });
  });
  it("buildProjectCost preserves the numeric baseline while adding provenance extensions", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (1, 'baseline-claude', '2026-08-12T12:00:00Z', 'my-repo', 'my-app', 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'sess-2', 'claude', 'claude', 0);
    `);
    const res = buildPreparedProjectCost(db, rateCards as any, homeToSubId, { since: "2026-08-01", until: "2026-08-31" });
    const projected = projectPreReqCostFields(res);
    const { notes: currentNotes, ...numeric } = projected;
    const { notes: priorNotes, ...baseline } = JSON.parse(PRE_REQ_PROJECT_COST_BASELINE_JSON);
    expect(JSON.stringify(numeric)).toBe(JSON.stringify(baseline));
    expect(currentNotes).toEqual(res.notes);
    expect(currentNotes[0]).toContain("datowanego okresu planu");
    const app = res.subjects.find((s) => s.id === "my-app");
    expect(app?.tokens).toBe(2_200_000);
    expect(app?.billed_complete).toBe(true);
    expect(app?.share_of_priced_spend_pct).toBe(100);
    expect(app?.priced_spend_usd).toBe(13.14);
    expect(app?.subscriptions.codex1).toBeDefined();
    expect(app?.subscriptions.claude).toBeDefined();
    expect(res.totals.tokens).toBe(2_200_000);
    expect(res.totals.calls).toBe(2);
    expect(res.totals.non_tmp_tokens).toBe(2_200_000);
    expect(res.coverage.tmp_bucket.tokens).toBe(0);
    expect(res.subscriptions[0]?.plan_periods.length).toBeGreaterThan(0);
  });
  it("propagates null billed_usd through repo-history and keeps it distinct from a measured zero", () => {
    const mixed = createTestDb();
    mixed.run(`
      INSERT INTO grok_events (ts, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning, cost_ticks, session_id, store)
      VALUES ('2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'grok-4', 1000, 0, 0, 100, 0, 163230000000, 'g1', 'grok');
    `);
    mixed.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    const mixedCards = {
      ...rateCards,
      subscriptions: { ...rateCards.subscriptions, grok: { plan: "super" } },
    };
    const mixedOpts = {
      repo: null as string | null,
      projectId: "my-app",
      granularity: "day" as const,
      by: "none" as const,
      idleGapMinutes: 15,
      since: "2026-08-01",
      until: "2026-08-31",
      homeToSubId,
    };
    const mixedCost = buildPreparedProjectCost(mixed, mixedCards as never, homeToSubId, {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    const mixedHist = buildRepoHistory(mixed, { ...mixedOpts, rateCards: mixedCards as never });
    const grokSlice = mixedCost.subjects.find((s) => s.id === "my-app")?.subscriptions.grok;
    expect(grokSlice?.api_usd).toBeGreaterThan(0);
    expect(grokSlice?.billed_usd).toBeNull();
    expect(mixedHist.totals.by_sub.grok?.api_usd).toBe(grokSlice?.api_usd);
    expect(mixedHist.totals.by_sub.grok?.billed_usd).toBeNull();
    expect(JSON.stringify(mixedHist.totals.by_sub.grok)).toContain('"billed_usd":null');
    expect(JSON.stringify(mixedHist.totals.by_sub.grok)).not.toContain('"billed_usd":0');
    for (const point of mixedHist.points) {
      if (point.by_sub.grok) expect(point.by_sub.grok.billed_usd).toBeNull();
    }
    expect(mixedHist.totals.by_sub.codex1?.billed_usd).not.toBeNull();
    expect(typeof mixedHist.totals.by_sub.codex1?.billed_usd).toBe("number");
    expect(mixedHist.totals.billed_complete).toBe(false);
    expect(mixedHist.totals.billed_usd).not.toBeNull();
    const unpricedOnly = createTestDb();
    unpricedOnly.run(`
      INSERT INTO grok_events (ts, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning, cost_ticks, session_id, store)
      VALUES ('2026-08-10T12:00:00Z', 'my-repo', 'my-app', 'grok-4', 1000, 0, 0, 100, 0, 163230000000, 'g1', 'grok');
    `);
    prepareProviderProjectFacts(unpricedOnly,mixedCards as never);
    const unpricedHist = buildRepoHistory(unpricedOnly, { ...mixedOpts, rateCards: mixedCards as never });
    expect(unpricedHist.totals.by_sub.grok?.billed_usd).toBeNull();
    expect(unpricedHist.totals.billed_usd).toBeNull();
    expect(unpricedHist.totals.billed_complete).toBe(false);
    expect(unpricedHist.points.every((p) => p.billed_usd === null && p.billed_complete === false)).toBe(true);
    const declaredZero = createTestDb();
    declaredZero.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    const zeroCards = {
      ...rateCards,
      subscriptions: { codex1: { plan: "pro", usd_per_month: 0 } },
    };
    const zeroHist = buildRepoHistory(declaredZero, { ...mixedOpts, rateCards: zeroCards as never });
    expect(zeroHist.totals.by_sub.codex1?.api_usd).toBeGreaterThan(0);
    expect(zeroHist.totals.by_sub.codex1?.billed_usd).toBe(0);
    expect(zeroHist.totals.billed_usd).toBe(0);
    expect(zeroHist.totals.billed_complete).toBe(true);
  });
  it("buildRepoHistory billed_usd is strictly invariant across day, week, and month granularities with fractional numbers", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-05T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1234567, 0, 0, 123456, 0, 'sess-1');
    `);
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-12T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 765432, 0, 0, 76543, 0, 'sess-2');
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (1, 'fractional-claude', '2026-08-19T12:00:00Z', 'my-repo', 'my-app', 'claude-3-5-sonnet-20241022', 'standard', 987654, 0, 0, 0, 0, 98765, 'sess-3', 'claude', 'claude', 0);
    `);
    prepareClaudeProjectCostFacts(db);
    const queryOpts = {
      repo: null,
      projectId: "my-app",
      by: "vendor" as const,
      idleGapMinutes: 15,
      since: "2026-08-01",
      until: "2026-08-31",
      rateCards: rateCards as any,
      homeToSubId,
    };
    const resMonth = buildRepoHistory(db, { ...queryOpts, granularity: "month" });
    const resWeek = buildRepoHistory(db, { ...queryOpts, granularity: "week" });
    const resDay = buildRepoHistory(db, { ...queryOpts, granularity: "day" });
    expect(resDay.totals.api_usd).toBe(resMonth.totals.api_usd);
    expect(resWeek.totals.api_usd).toBe(resMonth.totals.api_usd);
    expect(resDay.totals.billed_usd).toBe(resMonth.totals.billed_usd);
    expect(resWeek.totals.billed_usd).toBe(resMonth.totals.billed_usd);
    expect(resDay.totals.by_sub["codex1"]?.billed_usd).toBe(resMonth.totals.by_sub["codex1"]?.billed_usd);
    expect(resDay.totals.by_sub["claude"]?.billed_usd).toBe(resMonth.totals.by_sub["claude"]?.billed_usd);
    expect(resDay.points.every((p) => p.billed_usd != null)).toBe(true);
    expect(resDay.totals.billed_usd).not.toBeNull();
    const dayBilledSum = round2(resDay.points.reduce((s, p) => s + (p.billed_usd ?? 0), 0));
    expect(resDay.totals.billed_usd).toBe(dayBilledSum);
    const dayApiSum = round2(resDay.points.reduce((s, p) => s + p.api_usd, 0));
    expect(dayApiSum).toBe(resDay.totals.api_usd);
    const cost = buildPreparedProjectCost(db, rateCards as never, homeToSubId, {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    const app = cost.subjects.find((s) => s.id === "my-app");
    expect(app?.subscriptions["codex1"]?.billed_usd).toBe(resDay.totals.by_sub["codex1"]?.billed_usd);
    expect(app?.subscriptions["claude"]?.billed_usd).toBe(resDay.totals.by_sub["claude"]?.billed_usd);
  });
  it("performs non-circular 4-axis reconciliation against ground-truth database sums", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'my-repo', 'my-app', 'gpt-4o', 1000000, 0, 0, 100000, 0, 'sess-1');
    `);
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-14T12:00:00Z', 'c:/users/test/.codex', 'tmp-repo', '_tmp', 'gpt-4o', 100000, 0, 0, 10000, 0, 'sess-3');
    `);
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-15T12:00:00Z', 'c:/users/test/.codex', null, null, 'gpt-4o', 50000, 0, 0, 5000, 0, 'sess-4');
    `);
    db.run(`
      INSERT INTO gemini_events (ts, fresh_in, cached_in, out_total, conversation_id, store)
      VALUES ('2026-08-16T12:00:00Z', 200000, 0, 20000, 'conv-1', 'gemini');
    `);
    const res = buildProjectCost(db, rateCards as any, homeToSubId, { since: "2026-08-01", until: "2026-08-31" });
    const independentGroundTruthTokens =
      (1000000 + 100000) +
      (100000 + 10000) +
      (50000 + 5000) +
      (200000 + 20000);
    expect(independentGroundTruthTokens).toBe(1485000);
    const independentGroundTruthCalls = 4;
    const independentGroundTruthApiUsd = 4.03;
    const independentGroundTruthPaidUsd = 39.42;
    expect(res.totals.tokens).toBe(independentGroundTruthTokens);
    expect(res.totals.calls).toBe(independentGroundTruthCalls);
    expect(res.totals.api_usd).toBe(independentGroundTruthApiUsd);
    expect(res.totals.paid_usd).toBe(independentGroundTruthPaidUsd);
    const nonTmpProjects = res.subjects.filter((s) => s.id !== "_tmp");
    const nonTmpTokens = nonTmpProjects.reduce((sum, s) => sum + s.tokens, 0);
    const nonTmpCalls = nonTmpProjects.reduce((sum, s) => sum + s.calls, 0);
    const nonTmpApiUsd = nonTmpProjects.reduce((sum, s) => sum + s.api_usd, 0);
    const nonTmpBilledUsd = nonTmpProjects.reduce((sum, s) => sum + (s.billed_usd ?? 0), 0);
    expect(nonTmpTokens + res.coverage.totals.tokens).toBe(independentGroundTruthTokens);
    expect(nonTmpCalls + res.coverage.totals.calls).toBe(independentGroundTruthCalls);
    expect(Math.round((nonTmpApiUsd + (res.coverage.totals.api_usd || 0)) * 100) / 100).toBe(independentGroundTruthApiUsd);
    expect(Math.round((nonTmpBilledUsd + (res.coverage.totals.billed_usd || 0)) * 100) / 100).toBe(independentGroundTruthPaidUsd);
    const appRow = res.subjects.find((s) => s.id === "my-app");
    expect(appRow?.billed_usd).toBe(34.28);
    expect(res.coverage.tmp_bucket.billed_usd).toBe(3.43);
    expect(res.coverage.unassigned.billed_usd).toBe(1.71);
    expect(res.totals.unassigned_billed_usd).toBe(1.71);
  });
  for (const sample of ["missing-rate", "internal-review", "zero-value"] as const) it(`single-period history preserves ${sample} evidence without writes`, () => {
    const db = createTestDb();
    try {
      const cards = sample === "zero-value" ? { ...rateCards, subscriptions: { codex1: { plan: "pro" } } } : rateCards;
      db.query(`INSERT INTO events(ts,home,repo,project_id,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,path)
        VALUES('2026-08-10T12:00:00Z','c:/users/test/.codex','my-repo','my-app','gpt-4o',?,0,0,?,0,'known')`)
        .run(sample === "zero-value" ? 0 : 1_000_000, sample === "zero-value" ? 0 : 100_000);
      if (sample !== "zero-value") db.exec(`INSERT INTO events(ts,home,repo,project_id,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,path)
        VALUES('2026-08-10T13:00:00Z','c:/users/test/.codex','my-repo','my-app','codex-auto-review',1000,0,0,100,0,'review')`);
      if (sample === "missing-rate") db.exec(`INSERT INTO events(ts,home,repo,project_id,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,path)
        VALUES('2026-08-10T14:00:00Z','c:/users/test/.codex','my-repo','my-app','missing-rate',1000,0,0,100,0,'missing')`);
      const range = { since: "2026-08-01", until: "2026-08-31" };
      const cost = buildProjectCost(db, cards as RateCard, homeToSubId, range);
      const opts = { repo: null, projectId: "my-app", granularity: "day" as const, by: "none" as const, idleGapMinutes: 15,
        ...range, rateCards: fixtureCodexCard(cards as RateCard), homeToSubId, machineOf: () => "FIXTURE" };
      buildRepoHistory(db, opts);
      const before = db.query("SELECT total_changes() n").get();
      const history = readRepoHistory(db, opts);
      expect(db.query("SELECT total_changes() n").get()).toEqual(before);
      const expected = sample === "internal-review" ? 6.57 : null;
      expect(cost.subjects.find(subject => subject.id === "my-app")!.billed_usd).toBe(expected);
      expect(history.totals.billed_usd).toBe(expected);
      expect(history.totals.billed_complete).toBe(sample === "internal-review");
      if (sample === "zero-value") expect(history.totals.calls).toBe(1);
    } finally { db.close(); }
  });
  it("unassigned billed_usd is the independently allocated share, not paid minus assigned", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T12:00:00Z', 'c:/users/test/.codex', 'r-a', 'proj-a', 'gpt-4o', 400000, 0, 0, 100000, 0, 'a');
    `);
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T13:00:00Z', 'c:/users/test/.codex', 'r-b', 'proj-b', 'gpt-4o', 200000, 0, 0, 50000, 0, 'b');
    `);
    db.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-10T14:00:00Z', 'c:/users/test/.codex', null, null, 'gpt-4o', 200000, 0, 0, 50000, 0, 'u');
    `);
    const oddCards = {
      ...rateCards,
      subscriptions: { codex1: { plan: "pro", usd_per_month: 7 } },
    };
    const res = buildProjectCost(db, oddCards as never, homeToSubId, {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    const a = res.subjects.find((s) => s.id === "proj-a");
    const b = res.subjects.find((s) => s.id === "proj-b");
    expect(res.totals.paid_usd).toBe(0.23);
    expect(a?.billed_usd).toBe(0.11);
    expect(b?.billed_usd).toBe(0.06);
    expect(res.coverage.unassigned.billed_usd).toBe(0.06);
    expect(res.totals.unassigned_billed_usd).toBe(0.06);
    expect(round2((a?.billed_usd ?? 0) + (b?.billed_usd ?? 0) + (res.coverage.unassigned.billed_usd ?? 0))).toBe(0.23);
    const histOpts = {
      repo: null,
      by: "none" as const,
      idleGapMinutes: 15,
      since: "2026-08-01",
      until: "2026-08-31",
      rateCards: oddCards as never,
      homeToSubId,
    };
    const histA = buildRepoHistory(db, { ...histOpts, projectId: "proj-a", granularity: "day" });
    const histB = buildRepoHistory(db, { ...histOpts, projectId: "proj-b", granularity: "day" });
    expect(histA.totals.by_sub["codex1"]?.billed_usd).toBe(0.11);
    expect(histB.totals.by_sub["codex1"]?.billed_usd).toBe(0.06);
    expect(histA.totals.by_sub["codex1"]?.billed_usd).toBe(a?.billed_usd);
    expect(histB.totals.by_sub["codex1"]?.billed_usd).toBe(b?.billed_usd);
  });
  it("repo-subject history excludes project-owned rows so dollars match project-cost r:<repo>", () => {
    const db = createTestDb();
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (1, 'repo-unassigned-1', '2026-08-10T12:00:00Z', 'mixed-repo', NULL, 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'r1', 'claude', 'claude', 0);
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (2, 'repo-unassigned-2', '2026-08-11T12:00:00Z', 'mixed-repo', '', 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'r2', 'claude', 'claude', 0);
    `);
    db.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, in_uncached, in_cache_read, cache_write_5m, cache_write_1h, in_cache_write, out_total, session_id, store, subscription_id, subscription_conflict)
      VALUES (3, 'repo-project-1', '2026-08-12T12:00:00Z', 'mixed-repo', 'owned-app', 'claude-3-5-sonnet-20241022', 'standard', 1000000, 0, 0, 0, 0, 100000, 'p1', 'claude', 'claude', 0);
    `);
    const cost = buildPreparedProjectCost(db, rateCards as never, homeToSubId, {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    const repoSubject = cost.subjects.find((s) => s.subject === "r:mixed-repo");
    const projectSubject = cost.subjects.find((s) => s.subject === "p:owned-app");
    expect(repoSubject).toBeDefined();
    expect(projectSubject).toBeDefined();
    expect(repoSubject!.calls).toBe(2);
    expect(projectSubject!.calls).toBe(1);
    const hist = buildRepoHistory(db, {
      repo: "mixed-repo",
      granularity: "day",
      by: "none",
      idleGapMinutes: 15,
      since: "2026-08-01",
      until: "2026-08-31",
      rateCards: rateCards as never,
      homeToSubId,
    });
    expect(hist.totals.calls).toBe(repoSubject!.calls);
    expect(hist.totals.api_usd).toBe(repoSubject!.api_usd);
    expect(hist.totals.billed_usd).toBe(repoSubject!.billed_usd);
    expect(hist.totals.by_sub["claude"]?.api_usd).toBe(repoSubject!.subscriptions["claude"]?.api_usd);
    expect(repoSubject!.subscriptions["claude"]?.billed_usd).toBe(hist.totals.by_sub["claude"]?.billed_usd);
    expect(hist.totals.calls).not.toBe(3);
  });
});
describe("Setup handler home conflict", () => {
  function stubCtx(): { ctx: AppContext; previousAccounts: AppContext["accounts"] } {
    const sqlite = new Database(":memory:");
    declareCodexEraPeriods(sqlite, []);
    const previousAccounts: AppContext["accounts"] = { version: 2, subscriptions: [{ id: "keep", vendor: "codex" }],
      sources: [{vendor:"codex",home:"C:\\keep-home"}] };
    const ctx = {
      sqlite,
      accounts: previousAccounts,
      homeToSubId: new Map([["sentinel", "keep"]]),
      subIdToHomes: new Map([["keep", ["C:\\keep-home"]]]),
      homeConflict: null,
      eras: buildEraIndex(previousAccounts.subscriptions),
      eraErrors: [],
    } as unknown as AppContext;
    return { ctx, previousAccounts };
  }
  function expectContextUntouched(
    ctx: AppContext,
    previousAccounts: AppContext["accounts"]
  ): void {
    expect(ctx.accounts).toBe(previousAccounts);
    expect(ctx.homeToSubId.get("sentinel")).toBe("keep");
    expect(ctx.homeToSubId.size).toBe(1);
    expect(ctx.subIdToHomes.get("keep")).toEqual(["C:\\keep-home"]);
    expect(ctx.subIdToHomes.size).toBe(1);
    expect(ctx.homeConflict).toBeNull();
  }
  async function postSetup(ctx: AppContext, payload: unknown): Promise<{ status: number; error?: string }> {
    const req = new Request("http://127.0.0.1/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await handleSetupSave(ctx, req);
    const body = (await res.json()) as { error?: string };
    return { status: res.status, error: body.error };
  }
  function expectWroteOnlyUnder(wrote: string[], root: string): void {
    const base = path.resolve(root);
    for (const p of wrote) {
      const rel = path.relative(base, path.resolve(p));
      expect(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)).toBe(false);
    }
  }
  it("rejects a conflicting source_home before persisting or rebuilding context", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const accountsPath = path.join(tmp, "accounts.json");
    const { ctx, previousAccounts } = stubCtx();
    const saveSpy = spyOn(setup, "saveSetup").mockImplementation(() => {
      throw new Error("saveSetup must not run for a conflicting declaration");
    });
    try {
      const res = await postSetup(ctx, {
        config: tmp,
        sources: [
          { vendor: "codex", machine: "PC", home: "H:\\archive\\codex\\one", source_home: "C:\\Users\\a\\.codex" },
          { vendor: "codex", machine: "PC", home: "H:\\archive\\codex\\two", source_home: "C:/Users/a/.codex" },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.error).toContain("local profile");
      expect(res.error).toContain("c:/users/a/.codex");
      expect(saveSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(accountsPath)).toBe(false);
      expectContextUntouched(ctx, previousAccounts);
    } finally {
      saveSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects a ${ARCHIVE} home that collides only under the submitted archive root", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const newArchive = path.resolve(tmp, "new-archive");
    const accountsPath = path.join(newArchive, "config", "accounts.json");
    const { ctx, previousAccounts } = stubCtx();
    const saveSpy = spyOn(setup, "saveSetup").mockImplementation(() => {
      throw new Error("saveSetup must not run for a conflicting declaration");
    });
    const absoluteUnderNew = path.join(newArchive, "codex", "one");
    const normalized = absoluteUnderNew.split(path.sep).join("/").toLowerCase().replace(/\/+$/, "");
    try {
      const res = await postSetup(ctx, {
        archive: newArchive,
        sources: [
          { vendor: "codex", home: "${ARCHIVE}/codex/one" },
          { vendor: "codex", machine: "PC", home: "H:\\archive\\codex\\other", source_home: absoluteUnderNew },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.error).toContain("profil");
      expect(res.error?.toLowerCase().replaceAll("\\", "/")).toContain(normalized);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(accountsPath)).toBe(false);
      expectContextUntouched(ctx, previousAccounts);
    } finally {
      saveSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects a collision that appears only under inherited TOKENATLAS_ARCHIVE, and persists archive selection outside .env", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const inheritedA = path.resolve(tmp, "inherited-a");
    const submittedB = path.resolve(tmp, "submitted-b");
    const configC = path.resolve(tmp, "config-c");
    const localState = path.join(tmp, "state");
    const accountsPath = path.join(configC, "accounts.json");
    const envFile = path.join(tmp, ".env");
    const prevInherited = process.env.TOKENATLAS_ARCHIVE;
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    const prevLocalState = process.env.TOKENATLAS_LOCAL_STATE;
    const { ctx, previousAccounts } = stubCtx();
    const normalizedInherited = path
      .join(inheritedA, "codex", "one")
      .split(path.sep)
      .join("/")
      .toLowerCase()
      .replace(/\/+$/, "");
    process.env.TOKENATLAS_ARCHIVE = inheritedA;
    delete process.env.TOKENATLAS_CONFIG;
    process.env.TOKENATLAS_LOCAL_STATE = localState;
    try {
      expect(() => setup.saveSetup({archive:submittedB,config:configC,sources:[]},{envFile}))
        .toThrow(setup.InheritedArchiveRootError);
      expect(fs.existsSync(envFile)).toBe(false);
      expect(fs.existsSync(submittedB)).toBe(false);
      delete process.env.TOKENATLAS_ARCHIVE;
      const wrote = setup.saveSetup(
        {
          archive: submittedB,
          config: configC,
          subscriptions: [{ id: "ok", home: "H:\\ok-home" }],
        },
        { envFile }
      );
      expect(wrote.ok).toBe(true);
      expect(fs.existsSync(accountsPath)).toBe(true);
      expect(wrote.wrote).toContain(envFile);
      expect(wrote.wrote).toContain(path.join(localState, "archive-location.sqlite"));
      expectWroteOnlyUnder(wrote.wrote, tmp);
      const envText = fs.readFileSync(envFile, "utf-8");
      expect(envText).not.toContain("TOKENATLAS_ARCHIVE=");
      expect(envText).toContain(`TOKENATLAS_CONFIG=${configC}`);
      expect(resolveArchiveRootFromEnv({ TOKENATLAS_LOCAL_STATE: localState })).toBe(submittedB);
      process.env.TOKENATLAS_ARCHIVE = inheritedA;
      expect(resolveArchiveRootFromEnv({ TOKENATLAS_ARCHIVE: inheritedA })).toBe(inheritedA);
      expect(inheritedA).not.toBe(submittedB);
      const res = await postSetup(ctx, {
        archive: submittedB,
        config: configC,
        sources: [
          { vendor: "codex", home: "${ARCHIVE}/codex/one" },
          { vendor: "codex", machine: "PC", home: "H:\\archive\\codex\\other", source_home: path.join(inheritedA, "codex", "one") },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.error).toContain("profil");
      expect(res.error?.toLowerCase().replaceAll("\\", "/")).toContain(normalizedInherited);
      expectContextUntouched(ctx, previousAccounts);
      const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as {
        subscriptions: Array<{ id: string }>;
      };
      expect(persisted.subscriptions.map((s) => s.id)).toEqual(["ok"]);
    } finally {
      if (prevInherited === undefined) delete process.env.TOKENATLAS_ARCHIVE;
      else process.env.TOKENATLAS_ARCHIVE = prevInherited;
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      if (prevLocalState === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
      else process.env.TOKENATLAS_LOCAL_STATE = prevLocalState;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("derives the config root from a submitted archive without a .env override", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const archive = path.resolve(tmp, "archive");
    const localState = path.join(tmp, "state");
    const envFile = path.join(tmp, ".env");
    const derived = path.join(archive, "config");
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    const prevArchive = process.env.TOKENATLAS_ARCHIVE;
    const prevLocalState = process.env.TOKENATLAS_LOCAL_STATE;
    delete process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_ARCHIVE;
    process.env.TOKENATLAS_LOCAL_STATE = localState;
    try {
      const wrote = setup.saveSetup(
        {
          archive,
          subscriptions: [{ id: "ok", home: "H:\\ok-home" }],
        },
        { envFile }
      );
      expect(wrote.ok).toBe(true);
      expect(fs.existsSync(path.join(derived, "accounts.json"))).toBe(true);
      expect(wrote.wrote).toContain(path.join(localState, "archive-location.sqlite"));
      expectWroteOnlyUnder(wrote.wrote, tmp);
      // Nothing to record in .env, so no blank file is written (it would only force a restart).
      expect(wrote.wrote).not.toContain(envFile);
      expect(fs.existsSync(envFile)).toBe(false);
      expect(resolveConfigRootFromEnv({ TOKENATLAS_LOCAL_STATE: localState })).toBe(derived);
    } finally {
      if (prevArchive === undefined) delete process.env.TOKENATLAS_ARCHIVE;
      else process.env.TOKENATLAS_ARCHIVE = prevArchive;
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      if (prevLocalState === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
      else process.env.TOKENATLAS_LOCAL_STATE = prevLocalState;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("re-save preserves account metadata and physical source fields the wizard does not edit", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const envFile = path.join(tmp, ".env");
    const accountsPath = path.join(tmp, "accounts.json");
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_CONFIG;
    fs.writeFileSync(
      accountsPath,
      JSON.stringify(
        { version: 2,
          subscriptions: [{ id: "codex1", vendor: "codex", note: "keep me" }],
          sources: [{ vendor: "codex", machine: "M1", login: "a", home: "${ARCHIVE}/codex/M1-a", source_home: "~/.codex" }],
        },
        null,
        2
      )
    );
    try {
      const wrote = setup.saveSetup(
        {
          config: tmp,
          subscriptions: [{ id: "codex2", home: "${ARCHIVE}/codex/M2-b" }],
          sources: [
            { vendor: "codex", home: "${ARCHIVE}/codex/M1-a", machine: "M1", login: "a", source_home: "~/.codex" },
            { vendor: "codex", home: "${ARCHIVE}/codex/M2-b", machine: "M2", login: "b" },
          ],
        },
        { envFile }
      );
      expect(wrote.ok).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as {
        subscriptions: Array<Record<string, unknown>>;
        sources: Array<Record<string, unknown>>;
      };
      const kept = persisted.subscriptions.find((s) => s.id === "codex1");
      expect(kept?.note).toBe("keep me");
      expect(kept?.home).toBeUndefined();
      expect(persisted.sources[0]?.source_home).toBe("~/.codex");
      const fresh = persisted.subscriptions.find((s) => s.id === "codex2");
      expect(fresh?.id).toBe("codex2");
      expect(fresh?.plan).toBeUndefined();
      expect(fresh?.note).toBeUndefined();
      expect(persisted.sources[1]).toMatchObject({ machine: "M2", login: "b", home: "${ARCHIVE}/codex/M2-b" });
    } finally {
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("round-trips two account metadata rows and one physical source without changing its dated periods", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-eras-"));
    const accountsPath = path.join(tmp, "accounts.json");
    const envFile = path.join(tmp, ".env");
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_CONFIG;
    const home = "${ARCHIVE}/codex/shared";
    const source = { vendor: "codex", machine: "PC", home, source_home: "~/.codex" };
    const db = new Database(":memory:");
    declareCodexEraPeriods(db, [
      { id: "codex-old", vendor: "codex", home: codexFolder("shared"), until: "2026-05-01" },
      { id: "codex-new", vendor: "codex", home: codexFolder("shared"), from: "2026-05-01" },
    ]);
    const periodRows = () => db.query("SELECT source, account, from_ts, until_ts FROM account_periods ORDER BY from_ts").all();
    const before = periodRows();
    fs.writeFileSync(
      accountsPath,
      JSON.stringify({
        version: 2,
        subscriptions: [
          { id: "codex-old", vendor: "codex", account: "old@example.com", note: "old era" },
          { id: "codex-new", vendor: "codex", account: "new@example.com", note: "new era" },
        ],
        sources: [source],
      })
    );
    try {
      setup.saveSetup(
        {
          config: tmp,
          sources: [source],
        },
        { envFile, sqlite: db }
      );
      const persisted = JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as {
        subscriptions: Array<Record<string, unknown>>;
        sources: Array<Record<string, unknown>>;
      };
      expect(persisted.subscriptions[0]).toMatchObject({
        id: "codex-old",
        account: "old@example.com",
        note: "old era",
      });
      expect(persisted.subscriptions[0]!.from).toBeUndefined();
      expect(persisted.subscriptions[0]!.until).toBeUndefined();
      expect(persisted.subscriptions[1]).toMatchObject({
        id: "codex-new",
        account: "new@example.com",
        note: "new era",
      });
      expect(persisted.subscriptions[1]!.until).toBeUndefined();
      expect(persisted.subscriptions[1]!.from).toBeUndefined();
      expect(persisted.sources).toEqual([source]);
      expect(periodRows()).toEqual(before);
    } finally {
      db.close();
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("requires an explicit fixture env target and blocks the repository .env in tests", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-env-guard-"));
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    delete process.env.TOKENATLAS_CONFIG;
    try {
      expect(() =>
        setup.saveSetup({ config: tmp, subscriptions: [{ id: "ok", home: "H:\\ok-home" }] })
      ).toThrow("requires an explicit envFile");
      expect(process.env.NODE_ENV).toBe("test");
      expect(() =>
        setup.saveSetup(
          { config: tmp, subscriptions: [{ id: "ok", home: "H:\\ok-home" }] },
          { envFile: path.join(REPO_ROOT, ".env") }
        )
      ).toThrow("tests may not write the repository .env");
      expect(fs.existsSync(path.join(tmp, "accounts.json"))).toBe(false);
    } finally {
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("refuses a save whose config root is shadowed by inherited TOKENATLAS_CONFIG", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const archive = path.resolve(tmp, "archive");
    const envFile = path.join(tmp, ".env");
    const derived = path.join(archive, "config");
    const oldConfig = path.resolve(tmp, "old-config");
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    process.env.TOKENATLAS_CONFIG = oldConfig;
    try {
      let thrown: unknown;
      try {
        setup.saveSetup(
          {
            archive,
            subscriptions: [{ id: "ok", home: "H:\\ok-home" }],
          },
          { envFile }
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(setup.InheritedConfigRootError);
      const err = thrown as setup.InheritedConfigRootError;
      expect(err.variable).toBe("TOKENATLAS_CONFIG");
      expect(err.message).toContain("TOKENATLAS_CONFIG");
      expect(err.message).toContain(oldConfig);
      expect(err.message).toContain(derived);
      expect(err.message).toContain("process environment");
      expect(fs.existsSync(path.join(derived, "accounts.json"))).toBe(false);
      expect(fs.existsSync(envFile)).toBe(false);
      expect(resolveConfigRootFromEnv(process.env)).toBe(oldConfig);
    } finally {
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects inherited TOKENATLAS_CONFIG that would shadow the repaired root before persisting", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-"));
    const archive = path.resolve(tmp, "archive");
    const derived = path.join(archive, "config");
    const oldConfig = path.resolve(tmp, "old-config");
    const accountsPath = path.join(derived, "accounts.json");
    const prevConfig = process.env.TOKENATLAS_CONFIG;
    const { ctx, previousAccounts } = stubCtx();
    const saveSpy = spyOn(setup, "saveSetup").mockImplementation(() => {
      throw new Error("saveSetup must not run when inherited TOKENATLAS_CONFIG shadows the target");
    });
    process.env.TOKENATLAS_CONFIG = oldConfig;
    try {
      const res = await postSetup(ctx, {
        archive,
        subscriptions: [{ id: "ok", home: "H:\\ok-home" }],
      });
      expect(res.status).toBe(400);
      expect(res.error).toContain("TOKENATLAS_CONFIG");
      expect(res.error).toContain(oldConfig);
      expect(res.error).toContain(derived);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(accountsPath)).toBe(false);
      expectContextUntouched(ctx, previousAccounts);
    } finally {
      saveSpy.mockRestore();
      if (prevConfig === undefined) delete process.env.TOKENATLAS_CONFIG;
      else process.env.TOKENATLAS_CONFIG = prevConfig;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("keeps setup and health reachable when subscription homes conflict", async () => {
    const { ctx } = stubCtx();
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-setup-health-"));
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
    try {
      ctx.homeConflict = new SubscriptionHomeConflictError("c:/shared", "codex1", "codex2");
      const fetch = createFetchHandler(ctx);
      // Path constants are bound at module import, so exercise setup in a fresh v2 process.
      const setupScript = `const {createFetchHandler}=await import(${JSON.stringify(path.resolve(import.meta.dir, "api.ts"))});
        const {SubscriptionHomeConflictError}=await import(${JSON.stringify(path.resolve(import.meta.dir, "capacity-equivalents.ts"))});
        const fetch=createFetchHandler({dbPath:${JSON.stringify(path.join(config, "fixture.sqlite"))},
          homeConflict:new SubscriptionHomeConflictError("c:/shared","codex1","codex2")});
        const response=await fetch(new Request("http://127.0.0.1/api/setup")); process.stdout.write(String(response.status));`;
      const setupProcess = Bun.spawn([process.execPath, "-e", setupScript], {
        env: { ...process.env, TOKENATLAS_CONFIG: config }, stdout: "pipe", stderr: "pipe",
      });
      const setupOutput = await new Response(setupProcess.stdout).text();
      const setupError = await new Response(setupProcess.stderr).text();
      expect({ exit: await setupProcess.exited, status: setupOutput, stderr: setupError }).toEqual({ exit: 0, status: "200", stderr: "" });
      const cost = await fetch(new Request("http://127.0.0.1/api/project-cost"));
      expect(cost.status).toBe(503);
      const costBody = (await cost.json()) as { error?: string };
      expect(costBody.error).toContain("codex1");
      expect(costBody.error).toContain("codex2");
      expect(costBody.error).toContain("c:/shared");
      const health = await fetch(new Request("http://127.0.0.1/api/health"));
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { status?: string; home_conflict?: string | null };
      expect(healthBody.status).toBe("degraded");
      expect(healthBody.home_conflict).toContain("codex1");
    } finally {
      fs.rmSync(config, { recursive: true, force: true });
    }
  });
  it("keeps plan absent and a physical login in the account label", async () => {
    const { ctx } = stubCtx();
    ctx.sqlite = new Database(":memory:");
    declareCodexEraPeriods(ctx.sqlite, []);
    ctx.sqlite.exec("CREATE TABLE claude_events(ts TEXT, path TEXT, account_key TEXT, subscription_id TEXT, subscription_conflict INTEGER)");
    ctx.accounts = { version:2, subscriptions:[{id:"codex_legacy",vendor:"codex"}],
      sources:[{vendor:"codex",login:"legacy_user",home:"C:/Users/test/.codex"}] };
    ctx.subIdToHomes.set("codex_legacy",["C:/Users/test/.codex"]);
    const fetch = createFetchHandler(ctx);
    const res = await fetch(new Request("http://127.0.0.1/api/accounts"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      subscriptions: Array<{ id: string; plan: string | null; label: string }>;
    };
    expect(data.subscriptions).toHaveLength(1);
    expect(data.subscriptions[0]!.id).toBe("codex_legacy");
    expect(data.subscriptions[0]!.plan).toBeNull();
    expect(data.subscriptions[0]!.label).toBe("codex_legacy (legacy_user)");
    ctx.sqlite.close();
  });
  it("uses dated plan periods rather than the rate-card hint or a retired stage in accounts and rate-card responses", async () => {
    const { ctx } = stubCtx();
    const db = new Database(":memory:");
    ctx.sqlite = db;
    declareCodexEraPeriods(db, []);
    db.exec("CREATE TABLE claude_events(id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, ts TEXT, path TEXT, account_key TEXT, subscription_id TEXT, subscription_conflict INTEGER NOT NULL DEFAULT 0, model TEXT, speed TEXT, store TEXT, repo TEXT, project_id TEXT, in_uncached INTEGER, in_cache_read INTEGER, in_cache_write INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER, out_total INTEGER)");
    ctx.accounts = {version:2, subscriptions:[{id:"sub_unassigned",vendor:"codex"},{id:"sub_dated",vendor:"codex"}],
      sources:[{vendor:"codex",login:"user1",home:codexFolder("home1")},
        {vendor:"codex",login:"user2",home:codexFolder("home2")}]};
    ctx.rateCards = {
      version: 2,
      currency: "USD",
      unit: "USD per 1,000,000 tokens",
      vendors: {
        openai: {
          verified: false,
          models: {
            "gpt-5.6-sol": { in_uncached: 5.0, in_cache_read: 0.5, out_total: 15.0 },
          },
        },
      },
      subscriptions: {
        sub_unassigned: {
          plan: "ratecard_plan_should_be_ignored",
          usd_per_month: 200,
        },
        sub_dated: {
          plan: "ratecard_plan_should_be_ignored",
          usd_per_month: 20,
        },
      },
    } as any;
    // Plan history is the account's plan periods; a retired plans.json stage is ignored.
    ctx.plans = { segments: [{ subscription: "sub_unassigned", plan: "pro", usd_per_month: 999, from: "2023-01-01" }] };
    ctx.plansCatalog = { provider_groups: [] };
    db.exec(`CREATE TABLE plan_periods (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
      from_ts TEXT NOT NULL, until_ts TEXT, plan TEXT NOT NULL, amount_minor INTEGER, currency TEXT, origin TEXT NOT NULL,
      first_seen TEXT, last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
    replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "codex", subject: "sub_dated", value: "plus", from: "2023-01-01",
      until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    const fetch = createFetchHandler(ctx);
    const accountsRes = await fetch(new Request("http://127.0.0.1/api/accounts"));
    const accountsBody = (await accountsRes.json()) as {
      subscriptions: Array<{ id: string; plan: string | null }>;
    };
    const unassignedAccount = accountsBody.subscriptions.find((s) => s.id === "sub_unassigned");
    const datedAccount = accountsBody.subscriptions.find((s) => s.id === "sub_dated");
    expect(unassignedAccount?.plan).toBeNull();
    expect(datedAccount?.plan).toBeNull();
    const rateCardsRes = await fetch(new Request("http://127.0.0.1/api/rate-cards"));
    const rateCardsBody = (await rateCardsRes.json()) as {
      subscriptions: Array<{ id: string; plan: string | null; usd_per_month: number | null }>;
    };
    const unassignedRateSub = rateCardsBody.subscriptions.find((s) => s.id === "sub_unassigned");
    const datedRateSub = rateCardsBody.subscriptions.find((s) => s.id === "sub_dated");
    expect(unassignedRateSub?.plan).toBeNull();
    expect(unassignedRateSub?.usd_per_month).toBe(200);
    expect(datedRateSub?.plan).toBe("plus");
    expect(datedRateSub?.usd_per_month).toBe(20);
    const leverageRes = await fetch(new Request("http://127.0.0.1/api/leverage"));
    expect(leverageRes.status).toBe(503);
    expect(await leverageRes.json()).toMatchObject({ usage_unavailable: [{provider: "codex", reason: "usage-price-inputs-unavailable"}] });
    const plansRes = await fetch(new Request("http://127.0.0.1/api/plans"));
    const plansBody = (await plansRes.json()) as {
      rows: Array<{ subscription: string; fallback_usd_per_month: number | null; plan_on_day: { plan: string | null } }>;
    };
    const unassignedPlanRow = plansBody.rows.find((r) => r.subscription === "sub_unassigned");
    const datedPlanRow = plansBody.rows.find((r) => r.subscription === "sub_dated");
    expect(unassignedPlanRow?.plan_on_day.plan).toBeNull();
    expect(unassignedPlanRow?.fallback_usd_per_month).toBe(200);
    expect(datedPlanRow?.plan_on_day.plan).toBe("plus");
    expect(datedPlanRow?.fallback_usd_per_month).toBe(20);
    const physicalOwnership = [
      { id: "sub_unassigned", vendor: "codex", home: codexFolder("home1") },
      { id: "sub_dated", vendor: "codex", home: codexFolder("home2") },
    ];
    const homeToSubId = indexSubscriptionHomes(physicalOwnership);
    const subCaps = buildSubscriptionCapacities(ctx.sqlite, ctx.rateCards, homeToSubId);
    expect(subCaps.get("sub_unassigned")?.plan).toBeNull();
    expect(subCaps.get("sub_dated")?.plan).toBeNull();
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0,
        reasoning_out INTEGER DEFAULT 0, path TEXT
      );
    `);
    for (const home of [codexFolder("home1"), codexFolder("home2")]) ctx.sqlite.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-20T10:00:00Z', ?, 'r1', 'p1', 'gpt-5.6-sol', 1000, 0, 0, 1000, 0, ?)`, [home, `${home}/session`]);
    declareCodexEraPeriods(db, physicalOwnership);
    createAnalysisSourceRevisions(db);
    installAnalysisTracking(db);
    while(!prepareSubscriptionFacts(db,"claude","claude",undefined,100,ctx.rateCards).complete) {}
    const cost = buildProjectCost(ctx.sqlite, ctx.rateCards, homeToSubId, { plansCatalog: ctx.plansCatalog });
    const unassignedCostSub = cost.subscriptions.find((s) => s.id === "sub_unassigned");
    const datedCostSub = cost.subscriptions.find((s) => s.id === "sub_dated");
    expect(unassignedCostSub?.plan).toBeNull();
    expect(datedCostSub?.plan).toBe("plus");
  });
  it("aggregates real unpriced tokens across all supported provider event tables in /api/health and excludes priced models", async () => {
    const { ctx } = stubCtx();
    const db = new Database(":memory:");
    ctx.sqlite = db;
    declareCodexEraPeriods(db, []);
    ctx.rateCards = {
      version: 2,
      currency: "USD",
      unit: "USD per 1,000,000 tokens",
      vendors: {
        openai: {
          verified: false,
          models: {
            "gpt-5.6-sol": { in_uncached: 5.0, in_cache_read: 0.5, out_total: 30.0 },
          },
        },
        anthropic: {
          verified: true,
          models: {
            "claude-sonnet-5": { in_uncached: 2.0, in_cache_read: 0.2, in_cache_write_5m: 2.5, in_cache_write_1h: 4.0, out_total: 10.0 },
          },
        },
        zai: {
          verified: false,
          models: {
            "glm-5.3": { in_uncached: 1.4, in_cache_read: 0.26, out_total: 4.4 },
          },
        },
        google: {
          verified: false,
          models: {
            "gemini-3.7-flash": { in_uncached: 0.3, in_cache_read: 0.075, out_total: 2.5 },
          },
        },
        xai: {
          verified: false,
          source: "local operator configuration; no shipped xAI model rates",
          models: {},
        },
      },
    } as any;
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0,
        reasoning_out INTEGER DEFAULT 0, path TEXT
      );
    `);
    ctx.sqlite.run(`
      INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, reasoning_out, path)
      VALUES ('2026-08-20T10:00:00Z', 'h1', 'r1', 'p1', 'codex-unpriced-model', 10000, 0, 0, 5000, 0, 'h1/s1'),
             ('2026-08-20T10:00:00Z', 'h1', 'r1', 'p1', 'shared-cross-provider-model', 5000, 0, 0, 2000, 0, 'h1/s3'),
             ('2026-08-20T10:00:00Z', 'h1', 'r1', 'p1', 'gpt-5.6-sol', 50000, 0, 0, 20000, 0, 'h1/s2');
    `);
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS claude_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL,
        ts TEXT, repo TEXT, project_id TEXT, model TEXT, speed TEXT, session_id TEXT, store TEXT,
        subscription_id TEXT, subscription_conflict INTEGER NOT NULL DEFAULT 0,
        in_uncached INTEGER DEFAULT 0, in_cache_read INTEGER DEFAULT 0, in_cache_write INTEGER DEFAULT 0,
        cache_write_5m INTEGER DEFAULT 0, cache_write_1h INTEGER DEFAULT 0, out_total INTEGER DEFAULT 0
      );
    `);
    ctx.sqlite.run(`
      INSERT INTO claude_events (id, call_id, ts, repo, project_id, model, speed, session_id, store, subscription_id, subscription_conflict, in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total)
      VALUES (1, 'unknown-claude-unpriced', '2026-08-20T11:00:00Z', 'r1', 'p1', 'claude-unpriced-model', NULL, 's1', 'c1', NULL, 0, 10000, 5000, 2000, 0, 0, 8000),
             (2, 'unknown-claude-sonnet', '2026-08-20T11:00:00Z', 'r1', 'p1', 'claude-sonnet-5', NULL, 's1', 'c1', NULL, 0, 20000, 10000, 0, 0, 0, 10000);
    `);
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS oc_events (
        id INTEGER PRIMARY KEY, store TEXT DEFAULT 'opencode', message_id TEXT,
        ts TEXT, repo TEXT, project_id TEXT, provider TEXT, model TEXT, session_id TEXT,
        in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0
      );
    `);
    ctx.sqlite.run(`
      INSERT INTO oc_events (ts, repo, project_id, provider, model, session_id, in_tok, out_tok, cache_read, cache_write)
      VALUES ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'zai', 'glm-unpriced-model', 's1', 20000, 10000, 0, 0),
             ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'zai', 'glm-5.3', 's1', 30000, 15000, 0, 0),
             ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'zai-coding-plan', 'glm-5.3-medium-control', 's1', 10000, 5000, 0, 0),
             ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'zhipuai-coding-plan', 'glm-5.3-medium-control', 's1', 10000, 5000, 0, 0),
             ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'unrelated-opencode-lane', 'glm-5.3', 's1', 12000, 6000, 0, 0),
             ('2026-08-20T10:00:00Z', 'my-repo', 'p1', 'unrelated-opencode-lane', 'shared-cross-provider-model', 's1', 3000, 1000, 0, 0);
    `);
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS grok_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store TEXT, session_id TEXT, prompt_id TEXT, ts TEXT, model TEXT,
        in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0
      );
    `);
    ctx.sqlite.run(`
      INSERT INTO grok_events (store, session_id, prompt_id, ts, model, in_tok, out_tok, cache_write)
      VALUES ('main', 's1', 'p1', '2026-08-20T10:00:00Z', 'grok-beta', 50000, 25000, 0);
    `);
    ctx.sqlite.run(`
      CREATE TABLE IF NOT EXISTS gemini_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store TEXT, conversation_id TEXT, gen_idx INTEGER, ts TEXT, ts_basis TEXT, path TEXT, model TEXT,
        fresh_in INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, out_total INTEGER DEFAULT 0
      );
    `);
    ctx.sqlite.run(`
      INSERT INTO gemini_events (store, conversation_id, gen_idx, ts, ts_basis, path, model, fresh_in, cached_in, out_total)
      VALUES ('main', 'c1', 1, '2026-08-20T10:00:00Z', 'conv', 'p', 'gemini-unpriced-model', 40000, 10000, 10000),
             ('main', 'c1', 2, '2026-08-20T10:00:00Z', 'conv', 'p', 'gemini-3.7-flash', 10000, 5000, 5000),
             ('main', 'c1', 3, '2026-08-20T10:00:00Z', 'conv', 'p', 'gemini-3.7-flash-medium-control', 15000, 5000, 5000);
    `);
    // Health reads the observed models and their tokens from the ledgers the maintenance worker prepares.
    installFactDayRevisions(ctx.sqlite);
    prepareUsageRegisters(ctx.sqlite, ctx.rateCards);
    const fetch = createFetchHandler(ctx);
    const res = await fetch(new Request("http://127.0.0.1/api/health"));
    expect(res.status).toBe(200);
    const health = (await res.json()) as {
      unpriced: {
        tokens: number;
        items: Array<{
          model: string;
          observed_provider: string;
          rate_vendor: string | null;
          tokens: number;
          reason: string;
          first_day?: string;
        }>;
        models: Record<string, { tokens: number; reason: string; observed_provider: string; rate_vendor: string | null }>;
      };
    };
    // The stored missing_rate valuations of the ledgers (the same source as /api/missing-rates): `tokens` and
    // `models` count what can be priced in Settings; a vendor without a rate card is listed as no_rate_card.
    expect(health.unpriced.tokens).toBe(162000);
    expect(Array.isArray(health.unpriced.items)).toBe(true);
    const sharedItems = health.unpriced.items.filter((i) => i.model === "shared-cross-provider-model");
    expect(sharedItems.length).toBe(2);
    expect(sharedItems.find((i) => i.observed_provider === "openai")).toEqual({
      model: "shared-cross-provider-model",
      observed_provider: "openai",
      rate_vendor: "openai",
      tokens: 7000,
      first_day: "2026-08-20",
      reason: "missing_rate",
    });
    expect(sharedItems.find((i) => i.observed_provider === "unrelated-opencode-lane")).toEqual({
      model: "shared-cross-provider-model",
      observed_provider: "unrelated-opencode-lane",
      rate_vendor: null,
      tokens: 4000,
      first_day: "2026-08-20",
      reason: "no_rate_card",
    });
    const unrelatedGlm = health.unpriced.items.find((i) => i.model === "glm-5.3" && i.observed_provider === "unrelated-opencode-lane");
    expect(unrelatedGlm).toBeDefined();
    expect(unrelatedGlm?.rate_vendor).toBeNull();
    expect(unrelatedGlm?.tokens).toBe(18000);
    expect(unrelatedGlm?.reason).toBe("no_rate_card");
    const zaiUnpriced = health.unpriced.items.find((i) => i.model === "glm-unpriced-model");
    expect(zaiUnpriced).toBeDefined();
    expect(zaiUnpriced?.rate_vendor).toBe("zai");
    expect(zaiUnpriced?.tokens).toBe(30000);
    // Grok's amounts are the money xAI reported, so a model without a list rate is not a missing price.
    expect(health.unpriced.items.find((i) => i.model === "grok-beta")).toBeUndefined();
    const geminiItem = health.unpriced.items.find((i) => i.model === "gemini-unpriced-model");
    expect(geminiItem).toBeDefined();
    expect(geminiItem?.rate_vendor).toBe("google");
    expect(geminiItem?.tokens).toBe(60000);
    // The ledger left this variant unpriced (no exact rate), so the amounts leave it out and the list says so.
    expect(health.unpriced.models["gemini-3.7-flash-medium-control"]?.tokens).toBe(25000);
    expect(health.unpriced.models["codex-unpriced-model"]?.tokens).toBe(15000);
    expect(health.unpriced.models["codex-unpriced-model"]?.reason).toBe("missing_rate");
    expect(health.unpriced.models["claude-unpriced-model"]?.tokens).toBe(25000);
    expect(health.unpriced.models["claude-unpriced-model"]?.reason).toBe("missing_rate");
    expect(health.unpriced.models["gpt-5.6-sol"]).toBeUndefined();
    expect(health.unpriced.models["claude-sonnet-5"]).toBeUndefined();
    expect(health.unpriced.models["gemini-3.7-flash"]).toBeUndefined();
    expect(health.unpriced.models["glm-5.3-medium-control"]).toBeUndefined();
    ctx.sqlite.exec("UPDATE oc_events SET message_id=CAST(id AS TEXT)");
    prepareProviderProjectFacts(ctx.sqlite,ctx.rateCards);
    while(!prepareSubscriptionFacts(db,"claude","claude",undefined,100,ctx.rateCards).complete) {}
    const projectCost = buildProjectCost(ctx.sqlite, ctx.rateCards, new Map(), {
      since: "2026-08-01",
      until: "2026-08-31",
    });
    expect(projectCost.unpriced.models["glm-unpriced-model"]).toBe(30000);
    expect(projectCost.unpriced.models["glm-5.3"]).toBe(18000);
    expect(projectCost.unpriced.models["glm-5.3-medium-control"]).toBeUndefined();
    const repoHist = buildRepoHistory(ctx.sqlite, {
      repo: null,
      projectId: "p1",
      granularity: "day",
      by: "none",
      idleGapMinutes: 15,
      rateCards: ctx.rateCards,
      homeToSubId: new Map(),
    });
    expect(repoHist.totals.by_sub.opencode?.api_usd).toBeGreaterThan(0);
    expect(repoHist.totals.by_sub.opencode?.api_usd).toBeCloseTo(0.18, 2);
  });
  it("resolves Codex capacities with null plan on error/catch and membership independent of cfg.plan", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE ratelimit (
        ts TEXT, home TEXT, window_minutes INTEGER, limit_id TEXT, resets_at INTEGER, used_percent REAL, path TEXT
      );
      CREATE TABLE events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, reasoning_out INTEGER, path TEXT
      );
    `);
    const homeMap = new Map<string, string>([
      ["c:/users/test/home-custom", "custom-account"],
    ]);
    const rateCards = {
      version: 2,
      currency: "USD",
      unit: "USD per 1,000,000 tokens",
      vendors: {},
      subscriptions: {
        "custom-account": {
          plan: "ratecard_pro",
          usd_per_month: 200,
        },
        "codex-default": {
          plan: "ratecard_plus",
          usd_per_month: 20,
        },
        "unrelated-non-codex": {
          plan: "pro",
          usd_per_month: 50,
        },
      },
    } as any;
    const caps = resolveCodexCapacities(db, rateCards, homeMap, rateCards.subscriptions);
    expect(caps.has("custom-account")).toBe(true);
    expect(caps.has("codex-default")).toBe(true);
    expect(caps.has("unrelated-non-codex")).toBe(false);
    expect(caps.get("custom-account")?.plan).toBeNull();
    expect(caps.get("custom-account")?.usd_per_month).toBe(200);
    expect(caps.get("codex-default")?.plan).toBeNull();
    expect(caps.get("codex-default")?.usd_per_month).toBe(20);
    const corruptedDb = new Database(":memory:");
    corruptedDb.run(`
      CREATE TABLE ratelimit (home TEXT);
      CREATE TABLE events (
        home TEXT, ts TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, reasoning_out INTEGER, path TEXT
      );
      INSERT INTO events (home, ts, model, in_tok, out_tok) VALUES ('c:/users/test/home-custom', '2026-08-10T12:00:00Z', 'gpt-4o', 100, 100);
      INSERT INTO ratelimit (home) VALUES ('c:/users/test/home-custom');
    `);
    const catchRateCards = { ...rateCards };
    prepareCodexLedgerFixture(corruptedDb,catchRateCards,homeMap);
    const catchCaps = resolveCodexCapacities(corruptedDb, catchRateCards, homeMap, catchRateCards.subscriptions);
    const customCatch = catchCaps.get("custom-account");
    expect(customCatch).toBeDefined();
    expect(customCatch?.plan).toBeNull();
    expect(customCatch?.usd_per_month).toBe(200);
    expect(customCatch?.capacity_basis).toBe("none");
    expect(customCatch?.note).toContain("Probe account index is preparing");
    const cardsPlanA = {
      ...rateCards,
      subscriptions: { "codex-default": { plan: "Plan_A", usd_per_month: 20 } },
    };
    const cardsPlanB = {
      ...rateCards,
      subscriptions: { "codex-default": { plan: "Plan_B", usd_per_month: 20 } },
    };
    const capsA = resolveCodexCapacities(db, cardsPlanA as any, homeMap, cardsPlanA.subscriptions);
    const capsB = resolveCodexCapacities(db, cardsPlanB as any, homeMap, cardsPlanB.subscriptions);
    expect(capsA.get("codex-default")?.plan).toBeNull();
    expect(capsB.get("codex-default")?.plan).toBeNull();
    expect(capsA.get("codex-default")).toEqual(capsB.get("codex-default"));
  });
});
