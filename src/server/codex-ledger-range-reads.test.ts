import { afterEach, expect, test } from "bun:test";
import { readCodexLedgerGroups, type LedgerRange, type LedgerStoredGroup } from "../db/codex-price-ledger";
import { codexLedgerCompatibilityDays, codexLedgerReadContext, readCodexLedgerOwnedSeries } from "../db/codex-ledger-adapters";
import { loadAccountResolver } from "./account-resolver";
import type { CODEX_LEDGER_VARIANTS } from "../db/codex-price-ledger-read";
import { subscriptionDeclarations } from "./capacity-equivalents";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { card, codexCallsScene, openedDatabases } from "./codex-window-calls.fixture";

/**
 * An instant range is read from the stored hour sums for its whole hours and from the calls only for the hours its ends
 * cut. Every range, end policy and grain gives the groups a read of the calls alone gives (the reference: the same range
 * with a filter the sums do not carry), before and after a late and a corrected call.
 */
afterEach(() => { for (const db of openedDatabases.splice(0)) db.close(); });
const HOUR = 3_600_000, at = (iso: string) => Date.parse(iso);
const sorted = (rows: readonly LedgerStoredGroup[]) => rows.map(row => JSON.stringify(row)).sort();
const ranges: LedgerRange[] = [
  { fromMs: at("2026-09-11T00:00:00Z"), toMs: at("2026-09-12T00:00:00Z") },
  { fromMs: at("2026-09-10T23:17:41.250Z"), toMs: at("2026-09-12T17:42:05.500Z") },
  { fromMs: at("2026-09-11T10:00:00Z"), toMs: at("2026-09-11T20:00:00Z"), startInclusive: false, endInclusive: true },
  { fromMs: at("2026-09-11T10:15:00Z"), toMs: at("2026-09-11T10:45:00Z") },
  { fromMs: at("2026-09-11T09:59:59.999Z"), toMs: at("2026-09-11T11:00:00.001Z"), endInclusive: true },
  { fromMs: at("2026-09-11T05:00:00Z"), toMs: at("2026-09-12T05:00:00Z"), since: "2026-09-11", until: "2026-09-11" },
];

function expectRangesMatchCalls(db: ReturnType<typeof codexCallsScene>["db"]) {
  for (const range of ranges) for (const grain of ["day", "hour"] as const) {
    const fromCalls = readCodexLedgerGroups(db, { ...range, grain, instantValidity: "valid" });
    expect(fromCalls.length).toBeGreaterThan(0);
    expect(sorted(readCodexLedgerGroups(db, { ...range, grain }))).toEqual(sorted(fromCalls));
  }
}

test("instant ranges read from hour sums and cut edges equal the same ranges read from the calls", () => {
  const { db } = codexCallsScene();
  expectRangesMatchCalls(db);
});

test("after a late and a corrected call the hour sums still equal the calls", () => {
  const { db, base } = codexCallsScene();
  db.query(`INSERT INTO events (home,path,ts,model,in_tok,cached_in,cache_write,out_tok,speed,billing_mode,plan_type,source_offset)
    VALUES ('c:/own','c:/own/late.jsonl','2026-09-11T10:40:13.000Z','gpt-6-astra',5000,100,0,50,'standard','allowance','pro',1)`).run();
  db.exec("UPDATE events SET in_tok=in_tok+777 WHERE rowid IN (SELECT rowid FROM events WHERE home='c:/own' ORDER BY ts LIMIT 5)");
  prepareCodexLedgerFixture(db, card, base.homeToSubId);
  expectRangesMatchCalls(db);
});

test("coarse owned groups give the same register rows as the groups of every dimension", () => {
  const { db, base } = codexCallsScene();
  const resolver = loadAccountResolver(db, subscriptionDeclarations(base.homeToSubId!)), ledger = codexLedgerReadContext(card);
  const canonical = (rows: ReturnType<typeof codexLedgerCompatibilityDays>) => rows
    .map(row => JSON.stringify({ ...row, variants: Object.fromEntries(Object.entries(row.variants).map(([key, value]) => [key, value])) })).sort();
  for (const range of [{ fromMs: at("2026-09-10T00:00:00Z"), toMs: at("2026-09-13T00:00:00Z") },
    { since: "2026-09-11", until: "2026-09-11", grain: "hour" as const }]) {
    const fine = readCodexLedgerOwnedSeries(db, range, resolver, ledger);
    const coarse = readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(db, range, resolver, ledger, undefined, { coarse: true });
    expect(coarse.length).toBeLessThan(fine.length);
    expect(canonical(codexLedgerCompatibilityDays(coarse))).toEqual(canonical(codexLedgerCompatibilityDays(fine)));
  }
  // A source changes hands at 10:15: the hour it falls in is cut, and each side keeps its owner.
  const owners = readCodexLedgerOwnedSeries<typeof CODEX_LEDGER_VARIANTS>(db, { since: "2026-09-11", until: "2026-09-11", grain: "hour" }, resolver, ledger, undefined, { coarse: true })
    .filter(({ group }) => group.stored.hour === at("2026-09-11T10:00:00Z") / HOUR && group.stored.source?.includes("main")).map(({ account }) => account);
  expect(new Set(owners)).toEqual(new Set(["before", "acct"]));
});
