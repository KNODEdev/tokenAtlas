import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountWindowEnds, OverrideCause, WindowEndOverride } from "../shared/window-end-overrides";
import { accountWindowEnds, currentWindowEndOverrides, handleWindowEndOverrides, readWindowEndOverrides, WINDOW_END_OVERRIDES_FILE } from "./window-end-overrides";
import { Database } from "../db/sqlite";
import { WINDOW_END_CAUSES_SCHEMA_SQL, type WindowEndCauseRow } from "../db/window-end-causes";
import { markWindowAnswersDirty } from "../db/window-answers";
import type { ProviderReset } from "../shared/provider-resets";
import { PROVIDER_RESETS } from "../shared/provider-resets";
import { database, iso } from "./billing-cycles.fixture";
import { prepareProbeReaderFixture } from "./probe-reader.fixture";
import { coveredByEntry, writePage } from "./dirty-pages";
import { markWindowEndCausesDirty } from "../db/window-end-causes";
import { advanceBillingCycles, cycleResets, resetBillingCycleClock } from "./billing-cycle-producer";
import { PLAN_PERIODS, recordPeriodReading, replaceDeclaredPeriods } from "../db/period-store";
import { CATALOG } from "./billing-cycles.fixture";
import {
  advanceWindowEndCauses, endCauseConfigDigest, bankedOrigin, classifyWindowEnd, creditEvidence, windowEndCausesStale,
  type CreditReading, type EndCauseInput, type EndWindow, type OwnEnd,
} from "./window-end-causes";

const H = 3_600_000, D = 24 * H, MIN = 60_000;

const tables = (db: Database) => (db.query(`SELECT name, sql FROM sqlite_master WHERE name IN ('window_end_causes','window_end_cause_dirty',
  'limit_windows_counter_end','limit_windows_order') ORDER BY name`)
  .all() as Array<{ name: string; sql: string }>).map((row) => [row.name, row.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "")]);

test("migration 0077 creates the tables exactly as the schema module declares them", () => {
  const reference = new Database(":memory:");
  reference.exec("CREATE TABLE limit_windows (provider TEXT, account TEXT, counter TEXT, start_ts TEXT, end_ts TEXT)");
  reference.exec(WINDOW_END_CAUSES_SCHEMA_SQL);
  expect(tables(database())).toEqual(tables(reference));
  expect(tables(reference).map(([name]) => name)).toEqual(["limit_windows_counter_end", "limit_windows_order", "window_end_cause_dirty", "window_end_causes"]);
});

test("the announced list has an id per entry, UTC instants and sources; approximate entries are marked", () => {
  expect(new Set(PROVIDER_RESETS.map((reset) => reset.id)).size).toBe(PROVIDER_RESETS.length);
  for (const reset of PROVIDER_RESETS) {
    expect(Number.isFinite(Date.parse(reset.at))).toBe(true);
    expect(reset.at.endsWith("Z")).toBe(true);
    expect(reset.source).toContain("https://");
  }
  expect(PROVIDER_RESETS.find((reset) => reset.id === "codex-2026-09-08T01:56-reset")!.source).toContain("2097174560412246215");
  expect(PROVIDER_RESETS.filter((reset) => reset.approximate).map((reset) => reset.id)).toEqual(["codex-2026-08-10-reset-second",
    "claude-2026-05-15-reset", "claude-2026-06-20-reset", "claude-2026-07-01-reset", "claude-2026-07-09-reset"]);
});

/* ------------------------------------------------------------------------------------------ */
/* Credits                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const END = Date.parse("2026-09-15T06:42:00Z");
const credit = (id: string, granted: string, expires: string) => ({ id, granted_at: granted, expires_at: expires });

test("a reset credit used at the end: the count falls between readings 30 min around it, each within 2 h", () => {
  const readings: CreditReading[] = [{ ts: END - 3 * H, count: 3, list: null }, { ts: END - 31 * MIN, count: 2, list: null },
    { ts: END - 5 * MIN, count: 2, list: null }, { ts: END + 10 * MIN, count: 1, list: null }, { ts: END + 31 * MIN, count: 1, list: null }];
  expect(creditEvidence(readings, END)).toMatchObject({ before: { ts: iso(END - 31 * MIN), count: 2 }, after: { ts: iso(END + 31 * MIN), count: 1 },
    used: true, consumed: null });
  // Without readings 30 min away the nearest ones count.
  expect(creditEvidence([{ ts: END - 5 * MIN, count: 2, list: null }, { ts: END + 5 * MIN, count: 1, list: null }], END)).toMatchObject({ used: true });
  // A gap longer than 2 h on either side tells nothing.
  expect(creditEvidence([{ ts: END - 25 * H, count: 1, list: null }, { ts: END + 36 * H, count: 0, list: null }], END)).toBeNull();
});

test("a credit expiring between the end and the after-reading is no evidence of use", () => {
  const soon = credit("S", "2026-08-16T06:00:00.000Z", iso(END + 10 * MIN));
  const kept = credit("K", "2026-09-22T20:23:40.000Z", "2026-10-22T20:23:40.000Z");
  expect(creditEvidence([{ ts: END - H, count: 2, list: [soon, kept] }, { ts: END + 30 * MIN, count: 1, list: [kept] }], END)).toMatchObject({ used: false, consumed: null });
});

test("with the credit list, a credit that vanished before its expiry is consumed; one that expired is never banked", () => {
  const a = credit("A", "2026-09-22T20:23:40.000Z", "2026-10-22T20:23:40.000Z"), b = credit("B", "2026-08-16T06:00:00.000Z", "2026-09-15T06:30:00.000Z");
  const used = creditEvidence([{ ts: END - H, count: 2, list: [a, b] }, { ts: END + H, count: 1, list: [b] }], END)!;
  expect(used).toMatchObject({ used: true, consumed: a });
  const expired = creditEvidence([{ ts: END - H, count: 2, list: [a, b] }, { ts: END + H, count: 1, list: [a] }], END)!;
  expect(expired).toMatchObject({ used: false, consumed: null });
});

test("a banked credit's origin: all accounts by an announced grant, another account's list or its count rising; else unknown", () => {
  const consumed = credit("A", "2026-09-29T18:45:34.000Z", "2026-10-29T18:45:34.000Z");
  const announced = PROVIDER_RESETS.filter((reset) => reset.kind === "banked");
  expect(bankedOrigin(consumed, [], announced, "codex")).toEqual({ origin: "all_accounts", by: "codex-2026-09-29T19:00-banked" });
  const late = credit("C", "2026-09-10T12:00:00.000Z", "2026-10-10T12:00:00.000Z");
  expect(bankedOrigin(late, [], announced, "codex")).toEqual({ origin: "unknown", by: null });
  const granted = Date.parse(late.granted_at);
  expect(bankedOrigin(late, [{ account: "codex2", readings: [{ ts: granted + 5 * D, count: 1, list: [credit("X", iso(granted + 30 * MIN), iso(granted + 30 * D))] }] }],
    [], "codex")).toEqual({ origin: "all_accounts", by: "codex2" });
  expect(bankedOrigin(late, [{ account: "codex3", readings: [{ ts: granted - H, count: 2, list: null }, { ts: granted + H, count: 3, list: null }] }],
    [], "codex")).toEqual({ origin: "all_accounts", by: "codex3" });
  expect(bankedOrigin(null, [{ account: "codex3", readings: [{ ts: granted - H, count: 2, list: null }, { ts: granted + H, count: 3, list: null }] }],
    announced, "codex")).toEqual({ origin: "unknown", by: null });
});

/* ------------------------------------------------------------------------------------------ */
/* Classification                                                                              */
/* ------------------------------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-11T12:00:00Z");
function win(account: string, start: string, end: string, reset: string, extra: Partial<EndWindow> = {}): EndWindow {
  return { provider: "codex", account, counter: "w", seq: 1, start: Date.parse(start), end: Date.parse(end), reset: Date.parse(reset), plan: "pro",
    first: 0, last: 60, ...extra };
}
// A week from 10-01 00:00 ending early on 10-03 09:22 (f = 0.34).
const W = win("codex1", "2026-10-01T00:00:00Z", "2026-10-03T09:22:00Z", "2026-10-08T00:00:00Z");
const NEXT = win("codex1", "2026-10-03T09:22:00Z", "2026-10-10T09:22:00Z", "2026-10-10T09:22:00Z", { seq: 2, first: 0 });
const classify = (extra: Partial<EndCauseInput> = {}) => classifyWindowEnd({ window: W, next: NEXT, credits: null, origin: null, others: [],
  observers: () => [], announced: [], now: NOW, ...extra });
const other = (account: string, endDeltaMs: number, own: OwnEnd = "early") =>
  ({ window: win(account, "2026-10-01T00:00:00Z", iso(W.end + endDeltaMs), "2026-10-09T00:00:00Z"), own });
const announcement = (atDeltaMs: number, extra: Partial<ProviderReset> = {}): ProviderReset =>
  ({ id: "x", provider: "codex", at: iso(W.end + atDeltaMs), kind: "reset", approximate: false, source: "https://example", ...extra });

test("open and scheduled ends carry no bonus", () => {
  expect(classify({ now: W.end - H })).toMatchObject({ cause: "open", bonus: 0 });
  const scheduled = { ...W, end: W.reset - 14 * MIN };
  expect(classify({ window: scheduled })).toMatchObject({ cause: "scheduled", bonus: 0 });
  expect(classify({ window: { ...W, end: W.reset - 16 * MIN } }).cause).not.toBe("scheduled");
});

test("a plan change starts a new allowance: its own cause, no bonus, never a reset", () => {
  // An upgrade (the next window of another plan), also when the next window's plan changes inside it.
  expect(classify({ next: { ...NEXT, plan: "plus" } })).toMatchObject({ cause: "plan_change", bonus: 0, evidence: { next: { plan: "plus" } } });
  expect(classify({ next: { ...NEXT, plan: "mixed:pro → max" } })).toMatchObject({ cause: "plan_change", bonus: 0 });
  // A plan change wins over a same planned reset and over credits used.
  const credits = { before: { ts: "", count: 2 }, after: { ts: "", count: 1 }, consumed: null, used: true };
  expect(classify({ next: { ...NEXT, plan: "plus", reset: W.reset }, credits }).cause).toBe("plan_change");
  // A window whose own plan changed inside it ends in its last plan: a successor of that plan is no plan change.
  expect(classify({ window: { ...W, plan: "mixed:plus → pro" }, next: { ...NEXT, plan: "pro" } }).cause).not.toBe("plan_change");
  expect(classify({ window: { ...W, plan: "mixed:plus → pro" }, next: { ...NEXT, plan: "plus" } }).cause).toBe("plan_change");
});

test("not a reset only when the % did not drop materially; a same-reset end falling from far up is a real reset", () => {
  // The next window's first reading at least the last − 2 pp.
  expect(classify({ next: { ...NEXT, first: 58 } })).toMatchObject({ cause: "not_reset", bonus: 0, evidence: { not_reset: "no_drop" } });
  // codex1 09-12 09:48: the same planned reset, 2 → 0.
  expect(classify({ window: { ...W, last: 2 }, next: { ...NEXT, first: 0, reset: W.reset } })).toMatchObject({ cause: "not_reset" });
  // The same planned reset from 9 % or with a fall of 9 pp: one allowance.
  expect(classify({ window: { ...W, last: 9 }, next: { ...NEXT, first: 0, reset: W.reset + MIN } })).toMatchObject({ cause: "not_reset", evidence: { not_reset: "same_reset" } });
  expect(classify({ window: { ...W, last: 40 }, next: { ...NEXT, first: 31, reset: W.reset } }).cause).toBe("not_reset");
  // The same planned reset after a fall from the limit to 0: a real reset, classified further (here unknown).
  expect(classify({ window: { ...W, last: 100 }, next: { ...NEXT, first: 0, reset: W.reset } })).toMatchObject({ cause: "unknown" });
  expect(classify({ window: { ...W, last: 100 }, next: { ...NEXT, first: 0, reset: W.reset } }).bonus).toBeGreaterThan(0);
  // not_reset comes before banked.
  const credits = { before: { ts: "", count: 2 }, after: { ts: "", count: 1 }, consumed: null, used: true };
  expect(classify({ next: { ...NEXT, first: 58 }, credits }).cause).toBe("not_reset");
});

test("a credit used at the end is banked with its origin, before any match with other accounts", () => {
  const credits = { before: { ts: iso(W.end - H), count: 2 }, after: { ts: iso(W.end + H), count: 1 }, consumed: null, used: true };
  const result = classify({ credits, origin: { origin: "unknown", by: null }, others: [other("codex2", 5 * MIN)] });
  expect(result).toMatchObject({ cause: "banked", banked_origin: "unknown", evidence: { credits: { before: { count: 2 }, after: { count: 1 } } } });
  expect(result.bonus).toBeCloseTo(1 - result.f!, 6);
  // Claude has no reset credits.
  expect(classify({ window: { ...W, provider: "claude" }, credits }).cause).not.toBe("banked");
});

test("provider: another account's real early end within an hour, or an announced reset within [end − 12 h, end + 2 h]", () => {
  const sure = classify({ others: [other("codex2", -50 * MIN), other("codex3", 3 * H)] });
  expect(sure).toMatchObject({ cause: "provider", evidence: { matched: [{ account: "codex2", dt_min: -50 }] } });
  expect(sure.bonus).toBeCloseTo(1 - (W.end - W.start) / (W.reset - W.start), 6);
  // Another account's banked or not-reset end is not a provider reset.
  expect(classify({ others: [other("codex2", 5 * MIN, "banked"), other("codex3", 5 * MIN, "not_reset")] }).cause).not.toBe("provider");
  expect(classify({ announced: [announcement(-11 * H)] })).toMatchObject({ cause: "provider", evidence: { announced: { id: "x", dt_min: -660 } } });
  expect(classify({ announced: [announcement(35 * MIN)] }).cause).toBe("provider");
  expect(classify({ announced: [announcement(3 * H)] }).cause).not.toBe("provider");
  expect(classify({ announced: [announcement(-13 * H)] }).cause).not.toBe("provider");
  // A banked announcement is not a counter reset.
  expect(classify({ announced: [announcement(0, { kind: "banked" })] }).cause).not.toBe("provider");
  expect(classify({ announced: [announcement(0, { provider: "claude" })] }).cause).not.toBe("provider");
});

test("provider_probable: another account's early end within 12 h, or an approximate announcement within 24 h", () => {
  expect(classify({ others: [other("codex2", -11 * H)] })).toMatchObject({ cause: "provider_probable", evidence: { matched: [{ dt_min: -660 }] } });
  expect(classify({ announced: [announcement(20 * H, { approximate: true })] })).toMatchObject({ cause: "provider_probable" });
  // An approximate announcement never makes a sure match.
  expect(classify({ announced: [announcement(0, { approximate: true })] }).cause).toBe("provider_probable");
  expect(classify({ others: [other("codex2", -13 * H)] }).cause).not.toBe("provider_probable");
});

test("single needs other accounts observed and the account's own credit readings; otherwise unknown, and never for Claude", () => {
  let asked = 0;
  const credits = { before: { ts: iso(W.end - H), count: 2 }, after: { ts: iso(W.end + H), count: 2 }, consumed: null, used: false };
  expect(classify({ credits, observers: () => { asked++; return ["codex2"]; } })).toMatchObject({ cause: "single", evidence: { observers: ["codex2"] } });
  expect(asked).toBe(1);
  // Without the account's credit readings around the end a banked reset cannot be ruled out.
  expect(classify({ observers: () => ["codex2"] }).cause).toBe("unknown");
  // Claude: provider or unknown only.
  expect(classify({ window: { ...W, provider: "claude" }, credits, observers: () => ["claude-b"] }).cause).toBe("unknown");
  const unknown = classify({ credits });
  expect(unknown.cause).toBe("unknown");
  expect(unknown.bonus).toBeGreaterThan(0);
  // Observers are not asked once a provider match decides.
  asked = 0;
  classify({ others: [other("codex2", 0)], observers: () => { asked++; return []; } });
  expect(asked).toBe(0);
});

test("evidence that may still arrive keeps the row queued until end + 2 h and end + 12 h", () => {
  expect(classify({ now: W.end + H }).evidence.pending_until).toBe(iso(W.end + 2 * H));
  expect(classify({ now: W.end + 3 * H }).evidence.pending_until).toBe(iso(W.end + 12 * H));
  expect(classify({ now: W.end + 13 * H }).evidence.pending_until).toBeNull();
});

/* ------------------------------------------------------------------------------------------ */
/* The producer step                                                                           */
/* ------------------------------------------------------------------------------------------ */

const COUNTER = JSON.stringify(["codex", "codex", 10080]);
function addWindow(db: Database, account: string, seq: number, start: number, end: number, reset: number, first = 0, last = 60) {
  // A reading every 30 min, the % rising linearly from `first` to `last`.
  const steps = Math.max(1, Math.floor((end - start) / (30 * MIN)));
  const readings = Array.from({ length: steps }, (_, i) => ({ ts: iso(start + MIN + i * (end - start - 2 * MIN) / Math.max(1, steps - 1)),
    percent: Math.round(first + (last - first) * i / Math.max(1, steps - 1)), source: "probe" }));
  db.query(`INSERT OR REPLACE INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
    plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('codex',?,?,?,?,?,?,?,'reset',10080,'pro',NULL,0,?,NULL,NULL,NULL,1,?)`)
    .run(account, COUNTER, seq, `${account}|${seq}`, iso(start), iso(end), iso(reset), JSON.stringify(readings), iso(start));
}
/** A credit reading recorded under a raw subject; its owner comes from the account periods (`owned`). */
function addCredits(db: Database, subject: string, ts: number, count: number) {
  db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,window_minutes,used_percent,reported_percent_side,reset_credits,extra,ok)
    VALUES('codex',?,?,'primary','codex',10080,10,'used',?,'{}',1)`).run(subject, iso(ts), count);
}
/** Links the readings to their owners through physical sources and account periods, as the server does. */
const owned = (db: Database, owner: (subject: string) => string | null) =>
  prepareProbeReaderFixture(db, [{ id: "codex1" }, { id: "codex2" }], (row) => owner(row.subject), false);
const T0 = Date.parse("2026-09-01T00:00:00Z");
/**
 * codex1: an early end on 09-03 12:00 (credit 2 → 1: banked), one on 09-10 12:00 (alone: single, codex2 observed) and a
 * scheduled one. codex2: windows spanning both ends, its own early end on 09-17 12:30 matching codex1's 09-17 12:00 (provider).
 */
function seed(db: Database) {
  addWindow(db, "codex1", 0, T0, T0 + 2.5 * D, T0 + 7 * D);
  addWindow(db, "codex1", 1, T0 + 2.5 * D, T0 + 9.5 * D, T0 + 12 * D);
  addWindow(db, "codex1", 2, T0 + 9.5 * D, T0 + 16.5 * D, T0 + 16.5 * D + 3 * H);
  addWindow(db, "codex1", 3, T0 + 16.5 * D, T0 + 23.5 * D, T0 + 23.5 * D);
  addWindow(db, "codex2", 0, T0, T0 + 7 * D, T0 + 7 * D);
  addWindow(db, "codex2", 1, T0 + 7 * D, T0 + 14 * D, T0 + 14 * D);
  addWindow(db, "codex2", 2, T0 + 14 * D, T0 + 16.5 * D + 30 * MIN, T0 + 21 * D);
  addWindow(db, "codex2", 3, T0 + 16.5 * D + 30 * MIN, T0 + 23.5 * D, T0 + 23.5 * D);
  // Readings under raw subjects ("raw-…"): ownership comes from the account periods, never from the subject's name.
  for (const account of ["codex1", "codex2"])
    for (let t = T0; t < T0 + 23 * D; t += 60 * MIN) addCredits(db, `raw-${account}`, t, account === "codex1" && t > T0 + 2.5 * D ? 1 : 2);
  owned(db, (subject) => subject.replace("raw-", ""));
}
const LATER = Date.parse("2026-10-11T00:00:00Z");
const stored = (db: Database) => db.query("SELECT * FROM window_end_causes ORDER BY account, window_start").all() as WindowEndCauseRow[];
function settle(db: Database, now = LATER) {
  for (let i = 0; i < 20; i++) { const turn = advanceWindowEndCauses(db, { now, budgetMs: 10_000, announced: [], overrides: [] })!; if (!turn.pending) return turn; }
  throw new Error("end causes did not settle");
}

test("the step stores every window's cause; a repeat writes nothing", () => {
  const db = database();
  seed(db);
  settle(db);
  expect(stored(db).map((row) => [row.account, row.window_end.slice(0, 16), row.cause])).toEqual([
    ["codex1", "2026-09-03T12:00", "banked"], ["codex1", "2026-09-10T12:00", "single"], ["codex1", "2026-09-17T12:00", "provider"],
    ["codex1", "2026-09-24T12:00", "scheduled"],
    ["codex2", "2026-09-08T00:00", "scheduled"], ["codex2", "2026-09-15T00:00", "scheduled"], ["codex2", "2026-09-17T12:30", "provider"],
    ["codex2", "2026-09-24T12:00", "scheduled"]]);
  const single = stored(db)[1]!;
  expect(JSON.parse(single.evidence).observers).toEqual(["codex2"]);
  expect(single.bonus).toBeCloseTo(1 - 7 / 9.5, 6);
  const banked = stored(db)[0]!;
  expect(banked).toMatchObject({ banked_origin: "unknown", f: Number((2.5 / 7).toFixed(6)) });
  expect(banked.bonus).toBeCloseTo(1 - 2.5 / 7, 6);
  const before = stored(db);
  expect(settle(db)).toMatchObject({ written: 0, removed: 0, backlog: 0 });
  expect(stored(db)).toEqual(before);
  expect(windowEndCausesStale(db, "codex", "codex1")).toBe(false);
}, 30_000);

test("a change of another account's window re-classifies this account's end within 12 h, and marks only its cycles", () => {
  const db = database();
  seed(db);
  settle(db);
  db.exec("DELETE FROM billing_cycle_dirty");
  const before = stored(db);
  // codex2's window 1 now ends early at 09-10 12:40, 40 min after codex1's lone early end: both become provider resets.
  db.transaction(() => {
    addWindow(db, "codex2", 1, T0 + 7 * D, T0 + 9.5 * D + 40 * MIN, T0 + 14 * D);
    addWindow(db, "codex2", 2, T0 + 9.5 * D + 40 * MIN, T0 + 16.5 * D + 30 * MIN, T0 + 21 * D);
    db.query("DELETE FROM limit_windows WHERE account='codex2' AND seq=2 AND start_ts<>?").run(iso(T0 + 9.5 * D + 40 * MIN));
    markWindowAnswersDirty(db, { provider: "codex", account: "codex2", fromMs: T0 + 7 * D, untilMs: T0 + 16.5 * D + 30 * MIN });
  })();
  expect(windowEndCausesStale(db, "codex", "codex1")).toBe(true);
  settle(db);
  const after = stored(db);
  const codex1 = after.find((row) => row.account === "codex1" && row.window_end.startsWith("2026-09-10"))!;
  expect(codex1).toMatchObject({ cause: "provider" });
  expect(JSON.parse(codex1.evidence).matched).toEqual([{ account: "codex2", end: iso(T0 + 9.5 * D + 40 * MIN), dt_min: 40 }]);
  expect(before.find((row) => row.account === "codex1" && row.window_end.startsWith("2026-09-10"))!.computed_at).toBe(before[0]!.computed_at);
  // Rows far from the change are untouched; the cycles of both accounts holding the changed ends are queued.
  expect(after.find((row) => row.account === "codex1" && row.window_end.startsWith("2026-09-03"))).toEqual(before[0]!);
  expect((db.query("SELECT account FROM billing_cycle_dirty ORDER BY account").all() as Array<{ account: string }>).map((r) => r.account)).toEqual(["codex1", "codex2"]);
  // The same rows from nothing.
  const fresh = database();
  for (const table of ["limit_windows", "probe_windows"])
    for (const r of db.query(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      const columns = Object.keys(r);
      fresh.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((c) => r[c] as string | number | null));
    }
  owned(fresh, (subject) => subject.replace("raw-", ""));
  settle(fresh);
  const strip = (rows: WindowEndCauseRow[]) => rows.map(({ computed_at: _c, ...rest }) => rest);
  expect(strip(stored(fresh))).toEqual(strip(after));
}, 30_000);

/** One account's early end on 09-03 12:00 with a credit used across it, and a second account observed around it. */
function lone(db: Database, readings: (add: (subject: string, ts: number, count: number, list?: object[]) => void) => void) {
  addWindow(db, "codex1", 0, T0, T0 + 2.5 * D, T0 + 7 * D);
  addWindow(db, "codex1", 1, T0 + 2.5 * D, T0 + 9.5 * D, T0 + 9.5 * D);
  addWindow(db, "codex2", 0, T0, T0 + 7 * D, T0 + 7 * D);
  readings((subject, ts, count, list) => {
    addCredits(db, subject, ts, count);
    if (list) db.query("UPDATE probe_windows SET extra=? WHERE id=last_insert_rowid()").run(JSON.stringify({ "codex.reset_credits": JSON.stringify(list) }));
  });
}
const END3 = T0 + 2.5 * D;
const causeAt = (db: Database, account: string, end: number) => stored(db).find((row) => row.account === account && row.window_end === iso(end))!;

test("credit readings count for the account that owned them in that period, whatever their subject says", () => {
  // Readings recorded under "codex1" belonged to codex2 then (a handover): they say nothing about codex1's end.
  const handed = database();
  lone(handed, (add) => { add("codex1", END3 - H, 2); add("codex1", END3 + H, 1); });
  owned(handed, () => "codex2");
  settle(handed);
  expect(causeAt(handed, "codex1", END3).cause).toBe("unknown");
  // The same readings owned by codex1: its credit was used at the end.
  const own = database();
  lone(own, (add) => { add("raw", END3 - H, 2); add("raw", END3 + H, 1); });
  owned(own, () => "codex1");
  settle(own);
  expect(causeAt(own, "codex1", END3)).toMatchObject({ cause: "banked" });
}, 30_000);

test("a credit reading that arrives later re-classifies the end without any window change", () => {
  const db = database();
  lone(db, (add) => { add("raw", END3 - H, 2); });
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("unknown");
  addCredits(db, "raw", END3 + H, 1);
  owned(db, () => "codex1");
  expect(windowEndCausesStale(db, "codex", "codex1", LATER)).toBe(true);
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("banked");
  expect(windowEndCausesStale(db, "codex", "codex1", LATER)).toBe(false);
}, 30_000);

test("a credit reading corrected in place re-classifies the end through its ownership publication", () => {
  const db = database();
  lone(db, (add) => { add("raw", END3 - H, 2); add("raw", END3 + H, 1); });
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("banked");
  // The after-reading is corrected to 2 credits: no limit window moves, but its ownership publication marks the account.
  // No credit used and codex2 observed around the end: a single-account reset.
  db.query("UPDATE probe_windows SET reset_credits=2 WHERE subject='raw' AND ts=?").run(iso(END3 + H));
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("single");
  // Deleted: without the after-reading there is no credit evidence.
  db.query("DELETE FROM probe_windows WHERE subject='raw' AND ts=?").run(iso(END3 + H));
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("unknown");
}, 30_000);

test("clearing a reading's credits to null re-classifies the end, and a credit poll creates no window marks", () => {
  const db = database();
  lone(db, (add) => { add("raw", END3 - H, 2); add("raw", END3 + H, 1); });
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("banked");
  const marks = () => (db.query("SELECT count(*) AS n FROM window_answer_marks").get() as { n: number }).n;
  // A probe round with unchanged credits: queued for the end causes only, no window mark from the credit path.
  const before = marks();
  addCredits(db, "raw", END3 + 3 * H, 1);
  owned(db, () => "codex1");
  expect(marks()).toBe(before);
  expect(db.query("SELECT provider, account FROM window_end_cause_dirty").all()).toEqual([{ provider: "codex", account: "*" }]);
  settle(db);
  // The after-reading's credits are cleared (corrected to null): that reading is no evidence any more.
  db.query("UPDATE probe_windows SET reset_credits=NULL WHERE subject='raw' AND ts=?").run(iso(END3 + H));
  owned(db, () => "codex1");
  expect(marks()).toBe(before);
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("unknown");
}, 30_000);

test("credit evidence not yet owned is unavailable, not absent: the step waits and reports stale", () => {
  const db = database();
  lone(db, (add) => { add("raw", END3 - H, 2); add("raw", END3 + H, 1); });
  // The readings exist but their ownership is not written yet (the probe index is not published).
  const turn = advanceWindowEndCauses(db, { now: LATER, budgetMs: 10_000, announced: [] })!;
  expect(turn).toMatchObject({ pending: true, written: 0 });
  expect(stored(db)).toEqual([]);
  expect(windowEndCausesStale(db, "codex", "codex1", LATER)).toBe(true);
  owned(db, () => "codex1");
  settle(db);
  expect(causeAt(db, "codex1", END3).cause).toBe("banked");
}, 30_000);

test("a banked origin follows other accounts' readings around the consumed credit's grant, weeks before the end", () => {
  const db = database();
  const granted = "2026-08-20T12:00:00.000Z", a = credit("A", granted, "2026-09-19T12:00:00.000Z"), b = credit("B", "2026-08-25T00:00:00.000Z", "2026-09-24T00:00:00.000Z");
  lone(db, (add) => { add("raw1", END3 - H, 2, [a, b]); add("raw1", END3 + H, 1, [b]); });
  owned(db, (subject) => subject === "raw1" ? "codex1" : "codex2");
  settle(db);
  expect(causeAt(db, "codex1", END3)).toMatchObject({ cause: "banked", banked_origin: "unknown" });
  // codex2's reading from the day of the grant shows it got a credit then too.
  addCredits(db, "raw2", Date.parse(granted) - 30 * MIN, 0);
  addCredits(db, "raw2", Date.parse(granted) + 30 * MIN, 1);
  owned(db, (subject) => subject === "raw1" ? "codex1" : "codex2");
  settle(db);
  expect(causeAt(db, "codex1", END3)).toMatchObject({ cause: "banked", banked_origin: "all_accounts" });
}, 30_000);

test("freshness follows the producer: an overdue evidence checkpoint is stale until the step has run", () => {
  const db = database();
  lone(db, () => {});
  settle(db, END3 + H);
  expect(windowEndCausesStale(db, "codex", "codex1", END3 + H)).toBe(false);
  // At end + 2 h the row's checkpoint is due: stale until the next turn.
  expect(windowEndCausesStale(db, "codex", "codex1", END3 + 3 * H)).toBe(true);
  settle(db, END3 + 3 * H);
  expect(windowEndCausesStale(db, "codex", "codex1", END3 + 3 * H)).toBe(false);
});

test("more windows than a chunk falling due together are worked through once, without restarting the page", () => {
  const db = database();
  for (let i = 0; i < 70; i++) addWindow(db, `acc${String(i).padStart(2, "0")}`, 0, T0, T0 + 7 * D, T0 + 7 * D);
  settle(db, T0 + 6 * D);
  expect(stored(db).every((row) => row.cause === "open")).toBe(true);
  // All 70 close at once: each turn does one chunk, and the windows still due re-queue nothing they already hold.
  let turns = 0;
  for (; turns < 10; turns++) if (!advanceWindowEndCauses(db, { now: T0 + 8 * D, budgetMs: 1, announced: [] })!.pending) break;
  expect(turns).toBeLessThan(5);
  expect(stored(db).every((row) => row.cause === "scheduled")).toBe(true);
});

test("a month-long window closing is reached through the start bound like a weekly one", () => {
  const db = database();
  // A billing-period window of 30 days (Grok's kind), with a weekly window of another account beside it.
  db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,window_minutes,plan,plan_detail,
    plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input) VALUES('grok','g1','month',0,'m0',?,?,?,'scheduled',43200,'super',NULL,0,?,NULL,NULL,NULL,1,?)`)
    .run(iso(T0), iso(T0 + 30 * D), iso(T0 + 30 * D), JSON.stringify([{ ts: iso(T0 + D), percent: 10, source: "probe" }, { ts: iso(T0 + 29 * D), percent: 70, source: "probe" }]), iso(T0));
  addWindow(db, "codex1", 0, T0 + 23 * D, T0 + 30 * D, T0 + 30 * D);
  settle(db, T0 + 25 * D);
  expect(stored(db).map((row) => [row.provider, row.cause])).toEqual([["codex", "open"], ["grok", "open"]]);
  // Both close: the month-long one starts 30 days before its end, far beyond a week.
  const turn = settle(db, T0 + 31 * D);
  expect(turn.pending).toBe(false);
  expect(stored(db).map((row) => [row.provider, row.cause])).toEqual([["codex", "scheduled"], ["grok", "scheduled"]]);
});

test("clock work behind an active page's cursor is not covered by its entry", () => {
  const db = database();
  markWindowEndCausesDirty(db, "codex", "*", T0, T0 + 30 * D);
  const entry = db.query("SELECT provider, account, sequence FROM window_end_cause_dirty").get() as { provider: string; account: string; sequence: number };
  const covered = (from: number, longest: number) => coveredByEntry(db, "window_end_cause_dirty", "window_end_causes_page", "codex", "*", from, from + 1, longest);
  expect(covered(T0 + 10 * D, 8 * D)).toBe(true);
  // The page has passed windows starting up to day 20: work at day 10 may concern windows already done.
  writePage(db, "window_end_causes_page", entry, [iso(T0 + 20 * D), "codex", "a", "c"]);
  expect(covered(T0 + 10 * D, 8 * D)).toBe(false);
  // Work at day 29 concerns windows starting after day 28, still ahead of the cursor.
  expect(covered(T0 + 29 * D, D)).toBe(true);
  // With the window it is about: ahead of the cursor is covered, at or behind it is not.
  const about = (key: readonly [string, string, string, string]) => coveredByEntry(db, "window_end_cause_dirty", "window_end_causes_page", "codex", "*",
    T0 + 10 * D, T0 + 10 * D + 1, 8 * D, key);
  expect(about([iso(T0 + 20 * D), "codex", "b", "c"])).toBe(true);
  expect(about([iso(T0 + 20 * D), "codex", "a", "c"])).toBe(false);
  expect(about([iso(T0 + 3 * D), "codex", "z", "c"])).toBe(false);
});

test("more windows than a chunk overlapping one instant are worked through once, page by page", () => {
  const db = database();
  for (let i = 0; i < 70; i++) addWindow(db, `acc${String(i).padStart(2, "0")}`, 0, T0, T0 + 7 * D, T0 + 7 * D);
  let turns = 0, written = 0;
  for (; turns < 20; turns++) {
    const turn = advanceWindowEndCauses(db, { now: LATER, budgetMs: 1, announced: [] })!;
    written += turn.written;
    if (!turn.pending) break;
  }
  expect(turns).toBeLessThan(3);
  expect(written).toBe(70);
  expect(stored(db).every((row) => row.cause === "scheduled")).toBe(true);
});

test("a recent end is classified again once its credit readings and other accounts' ends can no longer change", () => {
  const db = database();
  seed(db);
  const soon = T0 + 9.5 * D + H;
  settle(db, soon);
  const early = () => stored(db).find((row) => row.account === "codex1" && row.window_end.startsWith("2026-09-10"))!;
  expect(JSON.parse(early().evidence).pending_until).toBe(iso(T0 + 9.5 * D + 2 * H));
  settle(db, T0 + 9.5 * D + 3 * H);
  expect(JSON.parse(early().evidence).pending_until).toBe(iso(T0 + 9.5 * D + 12 * H));
  settle(db, T0 + 9.5 * D + 13 * H);
  expect(JSON.parse(early().evidence).pending_until).toBeNull();
  expect(settle(db, T0 + 9.5 * D + 14 * H).written).toBe(0);
}, 30_000);

test("billing counts windows joined by an end that was not a reset as one allowance", () => {
  const db = database();
  // A week split at day 2 without a reset (the same planned reset, 5 → 0 %), then a whole week.
  addWindow(db, "codex1", 0, T0, T0 + 2 * D, T0 + 7 * D, 0, 5);
  addWindow(db, "codex1", 1, T0 + 2 * D, T0 + 7 * D, T0 + 7 * D, 0, 60);
  addWindow(db, "codex1", 2, T0 + 7 * D, T0 + 14 * D, T0 + 14 * D, 0, 50);
  recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: "codex1", ts: iso(T0 + H), value: "pro" });
  recordPeriodReading(db, PLAN_PERIODS, { provider: "codex", subject: "codex1", ts: iso(T0 + 13 * D), value: "pro" });
  settle(db, T0 + 15 * D);
  expect(stored(db)[0]!.cause).toBe("not_reset");
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: T0 + 15 * D, budgetMs: 10_000 })?.pending; i++);
  const cycle = db.query("SELECT windows_share, detail FROM billing_cycles WHERE account='codex1' ORDER BY start_ts LIMIT 1").get() as { windows_share: number; detail: string };
  expect(cycle.windows_share).toBeCloseTo(2, 6);
  expect(JSON.parse(cycle.detail).early_resets).toBe(0);
}, 30_000);

test("an upgrade split is a new allowance: never joined, no reset bonus, no early reset", () => {
  const db = database();
  // Plus until day 2 (planned reset day 7), then Pro from day 2: the upgrade restarted the meter under the new plan.
  addWindow(db, "codex1", 0, T0, T0 + 2 * D, T0 + 7 * D, 0, 80);
  addWindow(db, "codex1", 1, T0 + 2 * D, T0 + 9 * D, T0 + 9 * D, 0, 60);
  db.exec("UPDATE limit_windows SET plan='plus' WHERE seq=0");
  const declared = (value: string, from: number, until: number | null) => ({ provider: "codex", subject: "codex1", value, from: iso(from),
    until: until === null ? null : iso(until), origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "payment" });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("plus", T0, T0 + 2 * D), declared("pro", T0 + 2 * D, null)]);
  settle(db, T0 + 10 * D);
  expect(stored(db)[0]).toMatchObject({ cause: "plan_change", bonus: 0 });
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: T0 + 10 * D, budgetMs: 10_000 })?.pending; i++);
  const cycles = db.query("SELECT plan, windows_share, detail FROM billing_cycles WHERE account='codex1' ORDER BY start_ts").all() as Array<{ plan: string; windows_share: number; detail: string }>;
  // Each plan's cycle counts its own window whole; the Plus window's end is neither a reset nor a bonus.
  expect(cycles.map((c) => [c.plan, Math.round(c.windows_share * 1000) / 1000])).toEqual([["plus", 1], ["pro", 1]]);
  expect(JSON.parse(cycles[0]!.detail).early_resets).toBe(0);
  // The end at the upgrade instant opens the Pro cycle: listed there, with no bonus.
  expect(JSON.parse(cycles[1]!.detail).resets.plan_change).toMatchObject({ count: 1, windows: 0 });
}, 30_000);

test("a chain whose last fragment ends in a plan change counts no early reset", () => {
  const db = database();
  // Pro split at day 2 without a reset (5 → 0 %, the same planned reset), then an upgrade to Plus at day 4.
  addWindow(db, "codex1", 0, T0, T0 + 2 * D, T0 + 7 * D, 0, 5);
  addWindow(db, "codex1", 1, T0 + 2 * D, T0 + 4 * D, T0 + 7 * D, 0, 50);
  addWindow(db, "codex1", 2, T0 + 4 * D, T0 + 11 * D, T0 + 11 * D, 0, 30);
  db.exec("UPDATE limit_windows SET plan='plus' WHERE seq=2");
  const declared = (value: string, from: number, until: number | null) => ({ provider: "codex", subject: "codex1", value, from: iso(from),
    until: until === null ? null : iso(until), origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "payment" });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("pro", T0, T0 + 4 * D), declared("plus", T0 + 4 * D, null)]);
  settle(db, T0 + 12 * D);
  expect(stored(db).map((row) => row.cause)).toEqual(["not_reset", "plan_change", "scheduled"]);
  resetBillingCycleClock();
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: T0 + 12 * D, budgetMs: 10_000 })?.pending; i++);
  const pro = db.query("SELECT windows_share, used_pp, detail FROM billing_cycles WHERE account='codex1' AND plan='pro'").get() as { windows_share: number; used_pp: number; detail: string };
  expect(JSON.parse(pro.detail).early_resets).toBe(0);
  expect(pro.windows_share).toBeCloseTo(1, 6);
  // The meter restarted at the split (5 → 0): 5 + 50 points.
  expect(pro.used_pp).toBe(55);
}, 30_000);

/* ------------------------------------------------------------------------------------------ */
/* Reset bonuses of a billing cycle                                                            */
/* ------------------------------------------------------------------------------------------ */

test("a cycle's resets count the windows ending inside it by cause, with bonus windows, points and calibrated units", () => {
  const row = (end: string, cause: WindowEndCauseRow["cause"], bonus: number, origin: WindowEndCauseRow["banked_origin"] = null): WindowEndCauseRow => ({
    provider: "codex", account: "a", counter: COUNTER, window_start: iso(Date.parse(end) - D), window_end: end, planned_reset: end, f: 1 - bonus, bonus,
    cause, banked_origin: origin, evidence: "{}", inputs_rev: "x", computed_at: "x" });
  const rows = [row("2026-09-02T00:00:00.000Z", "provider", 0.5), row("2026-09-09T00:00:00.000Z", "provider", 0.25),
    row("2026-09-12T00:00:00.000Z", "banked", 0.4, "unknown"), row("2026-09-20T00:00:00.000Z", "scheduled", 0),
    row("2026-10-01T00:00:00.000Z", "single", 0.9), row("2026-08-31T23:00:00.000Z", "single", 0.9)];
  const cycle = { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2026-10-01T00:00:00Z") };
  const perPoint = { tokens_input: 10, tokens_cached: 5, tokens_output: 1, api_standard: 10, credits_low: 200, credits_high: 250 };
  const resets = cycleResets(rows, cycle, perPoint).resets!;
  expect(Object.keys(resets).sort()).toEqual(["banked", "provider", "scheduled"]);
  expect(resets.provider).toMatchObject({ count: 2, windows: 0.75, pp: 75, api_usd: 750, tokens: { input: 750, cached: 375, output: 75, total: 825 },
    credits: { low: 15_000, high: 18_750 } });
  expect(resets.banked).toMatchObject({ count: 1, windows: 0.4, origins: { all_accounts: 0, unknown: 1 } });
  expect(resets.scheduled).toMatchObject({ count: 1, windows: 0, pp: 0 });
  // Without a calibrated capacity the bonuses stay in windows and points only.
  expect(cycleResets(rows, cycle, null).resets!.provider).toMatchObject({ windows: 0.75, pp: 75, api_usd: null, tokens: null, credits: null });
  expect(cycleResets([], cycle, perPoint).resets).toBeNull();
  // Each bonus at the regime factor of its own window: the 09-02 end doubled, the 09-09 one not.
  const doubled = cycleResets(rows, cycle, perPoint, (start) => start === rows[0]!.window_start ? 2 : 1).resets!;
  expect(doubled.provider).toMatchObject({ windows: 0.75, pp: 75, api_usd: (50 * 2 + 25) * 10 });
});

test("a reset's bonus belongs to the time between the reset and its planned reset, split across the cycles it reaches", () => {
  // A window ending 2 days early on 09-29 (bonus 2/7): 1 of those 2 days lies after the cycle's end on 09-30.
  const reset: WindowEndCauseRow = { provider: "codex", account: "a", counter: COUNTER, window_start: "2026-09-24T00:00:00.000Z", window_end: "2026-09-29T00:00:00.000Z",
    planned_reset: "2026-10-01T00:00:00.000Z", f: 5 / 7, bonus: 2 / 7, cause: "provider", banked_origin: null, evidence: "{}", inputs_rev: "x", computed_at: "x" };
  const september = cycleResets([reset], { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2026-09-30T00:00:00Z") }, null).resets!;
  const october = cycleResets([reset], { start: Date.parse("2026-09-30T00:00:00Z"), end: Date.parse("2026-10-30T00:00:00Z") }, null).resets!;
  expect(september.provider).toMatchObject({ count: 1 });
  expect(september.provider!.windows).toBeCloseTo(1 / 7, 9);
  expect(october.provider).toMatchObject({ count: 0, carried: 1 });
  expect(october.provider!.windows).toBeCloseTo(1 / 7, 9);
  // A cycle holding only a sliver of windows never gets more bonus than it has windows: scaled down and flagged.
  const capped = cycleResets([reset], { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2026-09-30T00:00:00Z") }, null, () => 1, 0.1);
  expect(capped.capped).toBe(true);
  expect(capped.resets!.provider!.windows).toBeCloseTo(0.1, 9);
  // In calibrated units too: a one-window cycle at factor 1 and a 0.8-window bonus (its whole time inside) from a window at factor 2.
  const carried: WindowEndCauseRow = { ...reset, window_start: "2026-08-25T00:00:00.000Z", window_end: "2026-08-26T00:00:00.000Z",
    planned_reset: "2026-09-01T00:00:00.000Z", bonus: 0.8 };
  const perPoint = { tokens_input: 1, tokens_cached: 0, tokens_output: 0, api_standard: 1, credits_low: 1, credits_high: 1 };
  const weighted = cycleResets([carried], { start: Date.parse("2026-08-25T00:00:00Z"), end: Date.parse("2026-09-30T00:00:00Z") }, perPoint, () => 2, 1);
  const bonus = weighted.resets!.provider!;
  expect(weighted.capped).toBe(true);
  // Capacity $100 (1 window × 100 points × $1): the bonus never exceeds it, so the base is never negative.
  expect(bonus.api_usd!).toBeLessThanOrEqual(100 + 1e-9);
  expect(bonus.tokens!.total).toBeLessThanOrEqual(100);
  expect(bonus.credits!.high).toBeLessThanOrEqual(100 + 1e-9);
  // And in points: two factor-1 bonuses (0.8 + 0.77 windows) in a one-window cycle at factor 2 — weighted 1.57 < 2 passes,
  // but 157 bonus points against 100 capacity points would leave a negative base in points.
  const second: WindowEndCauseRow = { ...carried, window_start: "2026-08-26T00:00:00.000Z", window_end: "2026-08-27T00:00:00.000Z", bonus: 0.77 };
  const points = cycleResets([carried, second], { start: Date.parse("2026-08-25T00:00:00Z"), end: Date.parse("2026-09-30T00:00:00Z") }, perPoint, () => 1, 2, 1);
  expect(points.capped).toBe(true);
  expect(points.resets!.provider!.pp).toBeLessThanOrEqual(100 + 1e-9);
  expect(points.resets!.provider!.api_usd!).toBeLessThanOrEqual(200 + 1e-9);
});

/* ------------------------------------------------------------------------------------------ */
/* A person's corrections (Settings → Accounts → Windows)                                      */
/* ------------------------------------------------------------------------------------------ */

const correction = (account: string, end: string, cause: OverrideCause): WindowEndOverride => {
  const db = correctionSource!;
  const row = stored(db).find((r) => r.account === account && r.window_end.startsWith(end))!;
  return { provider: "codex", account, counter: row.counter, window_start: row.window_start, cause, updated_at: "2026-10-12T00:00:00.000Z" };
};
let correctionSource: Database | null = null;
function settleWith(db: Database, overrides: readonly WindowEndOverride[] | null) {
  for (let i = 0; i < 20; i++) { const turn = advanceWindowEndCauses(db, { now: LATER, budgetMs: 10_000, announced: [], overrides })!; if (!turn.pending) return turn; }
  throw new Error("end causes did not settle");
}

test("a correction changes only its window's kind, keeps the bonus and queues only its cycles; removing it restores the detected cause", () => {
  const db = correctionSource = database();
  seed(db);
  settle(db);
  db.exec("DELETE FROM billing_cycle_dirty");
  const before = stored(db);
  const single = correction("codex1", "2026-09-10", "provider");
  // A scheduled end is no early reset: its correction is ignored.
  const scheduled = correction("codex2", "2026-09-08", "banked");
  settleWith(db, [single, scheduled]);
  const after = stored(db);
  const changed = after.find((row) => row.window_start === single.window_start && row.account === "codex1")!;
  const was = before.find((row) => row.window_start === single.window_start && row.account === "codex1")!;
  expect(changed).toMatchObject({ cause: "provider", bonus: was.bonus, f: was.f, banked_origin: null });
  expect(JSON.parse(changed.evidence).manual).toEqual({ auto: "single" });
  expect(after.filter((row) => row !== changed)).toEqual(before.filter((row) => row !== was));
  expect((db.query("SELECT DISTINCT account FROM billing_cycle_dirty").all() as Array<{ account: string }>).map((r) => r.account)).toEqual(["codex1"]);
  // The same corrections again: nothing is queued or written.
  db.exec("DELETE FROM billing_cycle_dirty");
  expect(settleWith(db, [single, scheduled])).toMatchObject({ written: 0, removed: 0 });
  // Unreadable corrections keep the applied ones.
  expect(settleWith(db, null)).toMatchObject({ written: 0 });
  expect(stored(db).find((row) => row.window_start === single.window_start && row.account === "codex1")!.cause).toBe("provider");
  // Removed: the detected cause again, the same row as before the correction.
  settleWith(db, []);
  const strip = (rows: WindowEndCauseRow[]) => rows.map(({ computed_at: _c, ...rest }) => rest);
  expect(strip(stored(db))).toEqual(strip(before));
  expect((db.query("SELECT DISTINCT account FROM billing_cycle_dirty").all() as Array<{ account: string }>).map((r) => r.account)).toEqual(["codex1"]);
}, 30_000);

test("a banked correction carries an unknown origin; a corrected banked end drops its origin", () => {
  const db = correctionSource = database();
  seed(db);
  settle(db);
  settleWith(db, [correction("codex1", "2026-09-10", "banked"), correction("codex1", "2026-09-03", "unknown")]);
  const rows = stored(db).filter((row) => row.account === "codex1");
  expect(rows.find((row) => row.window_end.startsWith("2026-09-10"))).toMatchObject({ cause: "banked", banked_origin: "unknown" });
  expect(rows.find((row) => row.window_end.startsWith("2026-09-03"))).toMatchObject({ cause: "unknown", banked_origin: null });
}, 30_000);

test("Settings lists the main-counter windows with detected and chosen causes and saves against the read revision", async () => {
  const db = correctionSource = database();
  seed(db);
  settle(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-end-overrides-"));
  const url = "http://local/api/window-end-overrides?provider=codex&account=codex1";
  const call = async (body?: unknown) => {
    const response = await handleWindowEndOverrides(new Request(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), db, root);
    return { status: response.status, body: await response.json() as AccountWindowEnds & { error?: string } };
  };
  const listed = await call();
  expect(listed.status).toBe(200);
  expect(listed.body.windows.map((w) => [w.window_end.slice(0, 10), w.auto, w.override])).toEqual([
    ["2026-09-24", "scheduled", null], ["2026-09-17", "provider", null], ["2026-09-10", "single", null], ["2026-09-03", "banked", null]]);
  const target = listed.body.windows[2]!;
  const save = { revision: listed.body.revision, account: "codex1", counter: target.counter, window_start: target.window_start, cause: "provider" };
  const saved = await call(save);
  expect(saved.status).toBe(200);
  expect(saved.body.windows[2]).toMatchObject({ override: "provider", cause: "single" });
  expect(saved.body.pending).toBe(true);
  const repeated = await call({ ...save, revision: saved.body.revision });
  expect(repeated.body.revision).toBe(saved.body.revision);
  expect(repeated.status).toBe(200);
  // A stale revision, a scheduled end and a cause Codex does not offer are refused.
  expect((await call(save)).status).toBe(409);
  expect((await call({ ...save, revision: saved.body.revision, window_start: listed.body.windows[0]!.window_start })).status).toBe(409);
  expect((await call({ ...save, revision: saved.body.revision, cause: "provider_probable" })).status).toBe(400);
  // The background step applies the file's correction.
  settleWith(db, readWindowEndOverrides(root).overrides);
  const applied = await call();
  expect(applied.body.windows[2]).toMatchObject({ auto: "single", cause: "provider", override: "provider" });
  expect(applied.body.pending).toBe(false);
  // Choosing the detected cause again removes the correction.
  const removed = await call({ ...save, revision: applied.body.revision, cause: null });
  expect(readWindowEndOverrides(root).overrides).toEqual([]);
  expect(removed.body.pending).toBe(true);
  const concurrent = await Promise.all([call({ ...save, revision: removed.body.revision }),
    call({ ...save, revision: removed.body.revision, window_start: listed.body.windows[3]!.window_start, cause: "unknown" })]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
  fs.rmSync(root, { recursive: true, force: true });
}, 30_000);


test("the optional correction rule upgrades v3 without rebuilding unchanged windows", () => {
  const db = database();
  seed(db); settle(db);
  db.query("UPDATE meta SET value=? WHERE key='window_end_causes_config'").run(endCauseConfigDigest([], "window-end-causes-3"));
  db.exec("DELETE FROM billing_cycle_dirty");
  const before = stored(db);
  expect(settleWith(db, [])).toMatchObject({ written: 0, removed: 0, pending: false });
  expect(stored(db)).toEqual(before);
  expect(db.query("SELECT * FROM billing_cycle_dirty").all()).toEqual([]);
  expect(db.query("SELECT value FROM meta WHERE key='window_end_causes_config'").get()).toEqual({ value: endCauseConfigDigest([]) });
  db.close();
}, 30_000);

test("an interrupted correction resumes after reopening; an unchanged restart writes nothing", () => {
  const db = correctionSource = database();
  seed(db); settle(db);
  const chosen = [correction("codex1", "2026-09-10", "provider")];
  const before = stored(db);
  // Allow the durable correction set and dirty mark, then stop before publication.
  let checks = 0;
  expect(advanceWindowEndCauses(db, { now: LATER, announced: [], overrides: chosen, canWrite: () => ++checks < 3 })!.pending).toBe(true);
  expect(stored(db)).toEqual(before);
  const bytes = db.serialize(); db.close();
  const reopened = Database.deserialize(bytes);
  expect(settleWith(reopened, null)).toMatchObject({ written: 1, pending: false });
  const after = stored(reopened);
  expect(after.find((row) => row.account === "codex1" && row.window_start === chosen[0]!.window_start)!.cause).toBe("provider");
  const restarted = Database.deserialize(reopened.serialize()); reopened.close();
  const writes = () => (restarted.query("SELECT total_changes() AS n").get() as { n: number }).n;
  const count = writes();
  expect(settleWith(restarted, chosen)).toMatchObject({ written: 0, removed: 0, pending: false });
  expect(writes()).toBe(count);
  expect(stored(restarted)).toEqual(after);
  restarted.close();
}, 30_000);

test("missing declarations are empty; invalid declarations preserve applied corrections and cannot be overwritten", async () => {
  const db = correctionSource = database();
  seed(db); settle(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-end-overrides-invalid-"));
  try {
    expect(readWindowEndOverrides(root)).toEqual({ revision: "empty", overrides: [] });
    expect(currentWindowEndOverrides(root)).toEqual([]);
    const chosen = [correction("codex1", "2026-09-10", "provider")];
    const file = path.join(root, WINDOW_END_OVERRIDES_FILE);
    fs.writeFileSync(file, JSON.stringify({ revision: "one", overrides: chosen }));
    expect(currentWindowEndOverrides(root)).toEqual(chosen);
    settleWith(db, currentWindowEndOverrides(root));
    const applied = stored(db);
    for (const invalid of ["{broken", JSON.stringify({ revision: "bad", overrides: [{ ...chosen[0], cause: "scheduled" }] })]) {
      fs.writeFileSync(file, invalid);
      expect(() => readWindowEndOverrides(root)).toThrow();
      expect(currentWindowEndOverrides(root)).toBeNull();
      expect(settleWith(db, currentWindowEndOverrides(root))).toMatchObject({ written: 0 });
      expect(stored(db)).toEqual(applied);
      const response = await handleWindowEndOverrides(new Request("http://local/api/window-end-overrides?provider=codex&account=codex1", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...chosen[0], revision: "one" }),
      }), db, root);
      expect(response.status).toBe(500);
      expect(fs.readFileSync(file, "utf8")).toBe(invalid);
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("Settings includes both paid and Free main counters and excludes the shorter nested counter", () => {
  const db = database();
  seed(db);
  const monthly = JSON.stringify(["codex", "codex", 43200]);
  // Give Free and the nested 5h counter their own windows, beside the paid weekly counter.
  for (const [counter, minutes, plan] of [[monthly, 43200, "free"], ["five", 300, "pro"]] as const) {
    addWindow(db, "other", 0, T0 - 30 * D, T0, T0);
    db.query("UPDATE limit_windows SET account='codex1', counter=?, window_minutes=?, plan=? WHERE account='other'").run(counter, minutes, plan);
  }
  settle(db);
  const listed = accountWindowEnds(db, "codex", ["codex1"], { revision: "empty", overrides: [] });
  expect([...new Set(listed.windows.map((w) => w.counter))].sort()).toEqual([COUNTER, monthly].sort());
  db.close();
}, 30_000);
