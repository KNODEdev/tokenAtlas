import { expect, spyOn, test } from "bun:test";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { createClaudeCodeAcceptanceFixture, RATES } from "./claude-code-capacity.fixture";
import { compareDays, fillUsageLedger, ledgerDays, referenceDays } from "./usage-ledger.fixture";
import { stepUsageLedger, usageLedgerState } from "./usage-ledger-producer";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { readRegisterDays } from "../db/usage-price-read-account";
import { factTableRevision } from "../db/fact-day-revisions";
import { Database as Connection } from "../db/sqlite";
import { loadAccountResolver } from "./account-resolver";
import { priceSubscriptionEvent, subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import type { RateCard } from "./pricing";
import type { Database } from "../db/sqlite";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";

const discardLedger = (db: Database, provider: string) => {
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_state"]) db.query(`DELETE FROM ${table} WHERE provider=?`).run(provider);
};
const claudePath = (id: string, account = "account-a") => `${ARCHIVE_LOGICAL_ROOT}/claude/${account}/${id}.jsonl`;
function insertClaude(db: Database, row: { store?: string; call_id: string; ts: string; in_uncached: number; out_total: number;
  account?: string; project_id?: string | null; speed?: string | null; model?: string }) {
  db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,project_id)
    VALUES (?,?,?,?,?,?,?,?,'cli','2.1.0',?,?,?)`).run(row.store ?? "fixture-primary", row.call_id,
    `session-${row.call_id}`, claudePath(row.call_id, row.account), row.ts, row.model ?? "claude-sonnet-fixture", row.speed === undefined ? "standard" : row.speed,
    row.account ?? "account-a",
    row.in_uncached, row.out_total, row.project_id ?? null);
}

test("a first fill equals an independent full reference: counts exactly, money within float artifacts", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    discardLedger(fixture.db, "claude");
    fillUsageLedger(fixture.db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(fixture.db, "claude")?.status).toBe("ready");
    const ledger = ledgerDays(fixture.db, "claude");
    expect(ledger.size).toBeGreaterThan(5);
    expect(compareDays(ledger, referenceDays(fixture.db, "claude", fixture.rates))).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("appends, corrections, deletions, duplicates and conflicts reconcile to the reference's and a full refill's result", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const revision = usageLedgerState(db, "claude")!.revision;
    insertClaude(db, { call_id: "appended", ts: "2026-09-18T08:00:00.000Z", in_uncached: 4_000, out_total: 1_000 });
    // A second copy of an existing call with different tokens is a conflict; an identical one a duplicate.
    insertClaude(db, { store: "fixture-copy", call_id: "at-first", ts: "2026-09-15T00:00:00.000Z", in_uncached: 1, out_total: 1 });
    const unknown = db.query("SELECT * FROM claude_events WHERE call_id='unknown'").get() as Record<string, unknown>;
    db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
      VALUES ('fixture-copy','unknown',?,?,?,?,?,?,?,?,?,?)`).run(unknown.session_id as string, unknown.path as string, unknown.ts as string, unknown.model as string,
      unknown.speed as string, unknown.subscription_id as string, unknown.entrypoint as string | null, unknown.cc_version as string | null,
      unknown.in_uncached as number, unknown.out_total as number);
    db.query("UPDATE claude_events SET out_total=out_total+777 WHERE call_id='between'").run();
    db.query("DELETE FROM claude_events WHERE call_id='sdk'").run();
    // The writes changed source days; reconciling the first of them makes the ledger pending.
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "claude")).toMatchObject({ phase: "reconcile", status: "pending" });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "claude")!.revision).toBeGreaterThan(revision);
    const incremental = ledgerDays(db, "claude");
    expect(compareDays(incremental, referenceDays(db, "claude", fixture.rates))).toEqual([]);
    const total = (key: string) => [...incremental.values()].reduce((sum, day) => sum + day.quality[key]!, 0);
    expect(total("conflicted_identities")).toBe(1);
    expect(total("duplicates")).toBeGreaterThanOrEqual(2);
    discardLedger(db, "claude");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(ledgerDays(db, "claude")).toEqual(incremental);
  } finally { fixture.teardown(); }
}, 60_000);

test("a rate card change revalues only changed valuations and matches the reference under the new card", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const card = structuredClone(RATES) as RateCard;
    card.vendors.anthropic!.models!["claude-sonnet-fixture"]!.in_uncached = 3.25;
    const valuations = () => db.query("SELECT row_id,std_nano,std_femto,act_nano,act_femto FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id").all();
    const before = valuations();
    stepUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT, 3);
    expect(usageLedgerState(db, "claude")).toMatchObject({ phase: "revalue", status: "pending" });
    fillUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT);
    // Only facts with uncached input change value.
    const after = valuations() as Array<{ row_id: number }>;
    const inputs = new Map((db.query("SELECT id,in_uncached FROM claude_events").all() as Array<{ id: number; in_uncached: number }>).map(r => [r.id, r.in_uncached]));
    for (const [index, row] of after.entries())
      expect(JSON.stringify(row) === JSON.stringify(before[index])).toBe(!inputs.get(row.row_id));
    expect(compareDays(ledgerDays(db, "claude"), referenceDays(db, "claude", card))).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("a price change of one model from a date revalues exactly that model's facts after the date and equals a full refill (U3.3)", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const days = (db.query("SELECT DISTINCT day FROM usage_ledger_facts WHERE provider='claude' ORDER BY day").all() as Array<{ day: string }>).map(row => row.day);
    const until = days[Math.floor(days.length / 2)]!;
    const card = structuredClone(RATES) as RateCard;
    const model = card.vendors.anthropic!.models!["claude-sonnet-fixture"]!;
    // Dated card form: the entry's own rates hold through `until`, its `after` rates from the next day.
    Object.assign(model, { until, after: { ...model, in_uncached: 9, out_total: 21 } });
    const expected = (db.query("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude' AND model='claude-sonnet-fixture' AND day>?")
      .get(until) as { n: number }).n;
    const total = (db.query("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude'").get() as { n: number }).n;
    expect(expected).toBeGreaterThan(0); expect(expected).toBeLessThan(total);
    let revalued = 0;
    for (let turn = 0; turn < 10_000; turn++) {
      const step = stepUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT, 2);
      revalued += step.revalued ?? 0;
      if (step.complete) break;
    }
    expect(usageLedgerState(db, "claude")?.status).toBe("ready");
    expect(revalued).toBe(expected);
    const scoped = ledgerDays(db, "claude");
    expect(compareDays(scoped, referenceDays(db, "claude", card))).toEqual([]);
    discardLedger(db, "claude");
    fillUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT);
    expect(ledgerDays(db, "claude")).toEqual(scoped);
  } finally { fixture.teardown(); }
}, 60_000);

test("a Claude call without a Fast marker is Standard; the mode rule re-reads only the facts it changes, equal to a full refill", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db, day = "2026-09-17";
    // Subagent transcripts omit `speed`; an explicit Fast marker stays Fast (the fixture card has no Fast rate).
    insertClaude(db, { call_id: "mode-a", ts: `${day}T08:00:00.000Z`, in_uncached: 4_000, out_total: 1_000, speed: null });
    insertClaude(db, { call_id: "mode-b", ts: `${day}T09:00:00.000Z`, in_uncached: 2_000, out_total: 500, speed: null });
    insertClaude(db, { call_id: "mode-c", ts: `${day}T10:00:00.000Z`, in_uncached: 1_000, out_total: 100, speed: null, model: "claude-unrated" });
    insertClaude(db, { call_id: "mode-f", ts: `${day}T11:00:00.000Z`, in_uncached: 1_000, out_total: 100, speed: "fast" });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const speeds = () => (db.query(`SELECT e.call_id, f.speed, f.act_reason FROM usage_ledger_facts f JOIN claude_events e ON e.id=f.row_id
      WHERE f.provider='claude' AND e.call_id LIKE 'mode-%' ORDER BY e.call_id`).all() as Array<{ call_id: string; speed: string; act_reason: string | null }>)
      .map(row => [row.call_id, row.speed, row.act_reason]);
    expect(speeds()).toEqual([["mode-a", "standard", null], ["mode-b", "standard", null], ["mode-c", "standard", "missing_rate"], ["mode-f", "fast", "missing_rate"]]);
    // Known modes: no unknown-mode tokens; the unrated model and the unrated Fast call are unpriced for their rates.
    const sums = db.query(`SELECT SUM(unknown_speed_tokens) unknown, SUM(act_unpriced_events) unpriced FROM usage_ledger_days
      WHERE provider='claude' AND day=?`).get(day) as { unknown: number; unpriced: number };
    expect(sums).toEqual({ unknown: 0, unpriced: 2 });
    const refill = ledgerDays(db, "claude");

    // The ledger as the earlier rule left it: the three facts without a marker stored as `unknown`, unpriced for
    // their mode under a key without rates, with another fingerprint, their day's sums and the old digest.
    const old = (db.query(`INSERT INTO usage_ledger_keys(provider,key,rates) VALUES('claude',?,'null') RETURNING id`)
      .get(JSON.stringify(["anthropic", null, "unknown", 0])) as { id: number }).id;
    db.query(`UPDATE usage_ledger_facts SET speed='unknown', fingerprint='before-mode-rule', act_key=?1, glb_key=?1, act_reason='unknown_mode',
      act_usd=0, act_nano=0, act_femto=0, glb_reason='unknown_mode', glb_usd=0, glb_nano=0, glb_femto=0
      WHERE provider='claude' AND row_id IN (SELECT id FROM claude_events WHERE speed IS NULL)`).run(old);
    db.query("UPDATE usage_ledger_state SET rules_digest='before-mode-rule' WHERE provider='claude'").run();
    const total = (db.query("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude'").get() as { n: number }).n;
    let revalued = 0;
    for (let turn = 0; turn < 10_000; turn++) {
      const step = stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 2);
      revalued += step.revalued ?? 0;
      if (step.complete) break;
    }
    expect(usageLedgerState(db, "claude")?.status).toBe("ready");
    // Only the three stored as `unknown` are read again, out of all the provider's facts.
    expect(revalued).toBe(3); expect(total).toBeGreaterThan(10);
    expect(speeds()).toEqual([["mode-a", "standard", null], ["mode-b", "standard", null], ["mode-c", "standard", "missing_rate"], ["mode-f", "fast", "missing_rate"]]);
    expect(db.query("SELECT 1 FROM usage_ledger_facts WHERE provider='claude' AND (speed='unknown' OR fingerprint='before-mode-rule')").get()).toBeNull();
    expect(ledgerDays(db, "claude")).toEqual(refill);
    discardLedger(db, "claude");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(ledgerDays(db, "claude")).toEqual(refill);
    expect(compareDays(refill, referenceDays(db, "claude", fixture.rates))).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("a fill interrupted mid-resolution resumes on a new connection without losing or doubling facts", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    let db = fixture.db;
    discardLedger(db, "claude");
    for (let steps = 0; usageLedgerState(db, "claude")?.phase !== "resolve"; steps++) {
      if (steps > 200) throw new Error("no resolve phase");
      stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 3);
    }
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 3);
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 3);
    db = fixture.reopen();
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 3);
    expect(compareDays(ledgerDays(db, "claude"), referenceDays(db, "claude", fixture.rates))).toEqual([]);
    const facts = db.query("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude'").get() as { n: number };
    const rows = db.query("SELECT COUNT(*) n FROM claude_events").get() as { n: number };
    expect(facts.n).toBe(rows.n);
  } finally { fixture.teardown(); }
}, 60_000);

test("event reads return each canonical call once, in instant then copy-key order, with stored prices equal to per-event pricing", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    insertClaude(db, { store: "fixture-copy", call_id: "at-first", ts: "2026-09-15T00:00:00.000Z", in_uncached: 1, out_total: 1 });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const adapter = subscriptionAccountingAdapter("claude"), resolver = loadAccountResolver(db, []);
    for (const plan of [null, resolver.plan("claude", "account-a"), resolver.plan("claude", "account-b")]) {
      const reader = usageLedgerEvents(db, "claude", fixture.rates, plan);
      for (const [from, until, project] of [["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", undefined],
        ["2026-09-14T00:00:00.000Z", "2026-09-16T13:30:00.000Z", undefined], ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "project-subset"]] as const) {
        const events = reader.load(from, until, from, until, project);
        // The conflicted call is excluded; the duplicated one appears once.
        expect(events.some(event => event.identity === "at-first")).toBe(false);
        expect(new Set(events.map(event => event.identity)).size).toBe(events.length);
        for (let index = 1; index < events.length; index++) expect(events[index - 1]!.ts <= events[index]!.ts).toBe(true);
        if (plan) expect(events.every(event => event.account === plan.account)).toBe(true);
        for (const event of events) for (const standard of [true, false]) {
          const expected = priceSubscriptionEvent(fixture.rates, adapter, event, standard);
          const stored = standard ? event.prices.standard! : event.prices.actual!;
          expect(stored.reason).toBe(expected.reason);
          expect(Math.abs(stored.subtotal - expected.subtotal)).toBeLessThan(1e-12);
          for (const [bucket, cost] of Object.entries(expected.costs)) {
            const value = stored.costs[bucket as keyof typeof stored.costs];
            if (cost === null) expect(value).toBeNull();
            else expect(Math.abs(value! - cost)).toBeLessThan(1e-12);
          }
        }
      }
    }
    const stats = usageLedgerEvents(db, "claude", fixture.rates, null).stats("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    expect(stats).toEqual({ duplicates: 2, conflicts: 1 });
  } finally { fixture.teardown(); }
}, 60_000);

test("a partially rated call keeps its computable buckets in the subtotal and out of the priced subtotal", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const card = structuredClone(RATES) as RateCard;
    // Output has no rate: every call with output is unpriced, but its input still has a cost.
    (card.vendors.anthropic!.models!["claude-sonnet-fixture"] as unknown as Record<string, unknown>).out_total = null;
    fillUsageLedger(db, "claude", card, ARCHIVE_LOGICAL_ROOT);
    const days = ledgerDays(db, "claude");
    const actual = [...days.values()].map(day => day.variants.api_actual!).filter(amount => amount.unpricedEvents > 0);
    expect(actual.length).toBeGreaterThan(0);
    for (const amount of actual) {
      expect(Number(amount.subtotal)).toBeGreaterThan(0);
      expect(amount.pricedSubtotal).toBe("0");
      expect(amount.reasons.missing_rate![0]).toBe(amount.unpricedEvents);
    }
    expect(compareDays(days, referenceDays(db, "claude", card))).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("a conflict spanning two days is counted once and keeps the project subject of each day's marker", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    insertClaude(db, { call_id: "split", ts: "2026-09-15T10:00:00.000Z", in_uncached: 100, out_total: 10, project_id: "project-subset" });
    insertClaude(db, { store: "fixture-copy", call_id: "split", ts: "2026-09-16T10:00:00.000Z", in_uncached: 100, out_total: 10, project_id: "project-subset" });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const markers = [...ledgerDays(db, "claude")].filter(([, day]) => day.quality.conflicts! > 0);
    expect(markers.length).toBe(2);
    expect(markers.reduce((sum, [, day]) => sum + day.quality.conflicted_identities!, 0)).toBe(1);
    for (const [key] of markers) expect(JSON.parse(key)[5]).toBe("p:project-subset");
    expect(compareDays(ledgerDays(db, "claude"), referenceDays(db, "claude", fixture.rates))).toEqual([]);
  } finally { fixture.teardown(); }
}, 60_000);

test("an incomplete Grok identity is kept for global usage only, and copies merge reported money without repricing", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const card = structuredClone(RATES) as RateCard;
    card.vendors.xai = { source: "fixture", models: { "grok-fixture": { in_uncached: 2, in_cache_read: 0.5, out_total: 10 } } };
    const insert = db.query(`INSERT INTO grok_events (store,session_id,prompt_id,ts,model,path,in_tok,cached_in,cache_write,out_tok,reasoning,
      model_calls,api_duration_ms,cost_ticks,source_id) VALUES (?,?,?,?,?,?,?,0,0,?,0,1,0,?,'')`);
    const path = `${ARCHIVE_LOGICAL_ROOT}/grok/pc-fixture/session.json`;
    insert.run("pc-fixture", "s1", "p1", "2026-09-15T10:00:00.000Z", "grok-fixture", path, 1000, 100, 5_000_000);
    insert.run("pc-copy", "s1", "p1", "2026-09-15T10:00:00.000Z", "grok-fixture", path, 1000, 100, 7_000_000);
    insert.run("pc-fixture", "s2", "p2", "2026-09-15T11:00:00.000Z", null, path, 500, 50, 1_000_000);
    fillUsageLedger(db, "grok", card, ARCHIVE_LOGICAL_ROOT);
    const days = ledgerDays(db, "grok");
    expect(compareDays(days, referenceDays(db, "grok", card))).toEqual([]);
    const ineligible = [...days].find(([key]) => JSON.parse(key)[6] === "xai")![1];
    expect(ineligible.variants.api_standard!.pricedEvents + ineligible.variants.api_standard!.unpricedEvents).toBe(0);
    expect(ineligible.variants.api_global!.unpricedEvents).toBe(1);
    const events = usageLedgerEvents(db, "grok", card, null).load("2026-09-15T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
    expect(events.length).toBe(1);
    // Same tokens, different reported money: one call, money unknown and flagged, no conflict.
    expect(events[0]!.reported).toMatchObject({ usd: null, raw: null, conflict: true });
    expect(events[0]!.prices.actual!.amount).not.toBeNull();
    const valuation = () => db.query("SELECT act_nano,act_femto FROM usage_ledger_facts WHERE provider='grok' AND copy_state='canonical'").all();
    const priced = valuation();
    db.query("UPDATE grok_events SET cost_ticks=5000000 WHERE store='pc-copy'").run();
    fillUsageLedger(db, "grok", card, ARCHIVE_LOGICAL_ROOT);
    const corrected = usageLedgerEvents(db, "grok", card, null).load("2026-09-15T00:00:00.000Z", "2026-09-16T00:00:00.000Z");
    expect(corrected[0]!.reported).toMatchObject({ usd: 0.005, raw: 5_000_000 });
    expect(valuation()).toEqual(priced);
  } finally { fixture.teardown(); }
}, 60_000);

test("a provider covers its source's change revision, and an account period change costs the ledger nothing", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    insertClaude(db, { call_id: "later", ts: "2026-09-18T09:00:00.000Z", in_uncached: 10, out_total: 1 });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    fillUsageLedger(db, "gemini", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "gemini")!.covered).toBe(factTableRevision(db, "gemini_events")!);
    const revision = usageLedgerState(db, "claude")!.revision;
    const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared")
      .map(period => period.subject === "claude/account-a" ? { ...period, until: "2026-09-16T12:30:00.000Z" } : period);
    periods.push({ provider: "claude", subject: "claude/account-a", value: "account-c", from: "2026-09-16T12:30:00.000Z", until: null,
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);
    expect(stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    expect(usageLedgerState(db, "claude")!.revision).toBe(revision);
    // The cut day splits at the boundary when read: each call goes to the account that owned its instant.
    const resolver = loadAccountResolver(db, []);
    const rows = readRegisterDays(db, "usage-ledger:claude", "claude", resolver, { since: "2026-09-16", until: "2026-09-16" })
      .filter(row => row.source === "claude/account-a");
    const callsOf = (account: string) => rows.filter(row => row.account === account).reduce((sum, row) => sum + row.calls, 0);
    for (const account of ["account-a", "account-c"]) {
      const events = usageLedgerEvents(db, "claude", fixture.rates, resolver.plan("claude", account))
        .load("2026-09-16T00:00:00.000Z", "2026-09-17T00:00:00.000Z").filter(event => event.source === "claude/account-a");
      expect(callsOf(account)).toBe(events.length);
    }
    expect(callsOf("account-a")).toBeGreaterThan(0);
    expect(callsOf("account-c")).toBeGreaterThan(0);
  } finally { fixture.teardown(); }
}, 60_000);

test("a call moved to another day and the last call of a day reconcile like a full refill, reading only the changed days", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    insertClaude(db, { call_id: "alone", ts: "2026-09-20T10:00:00.000Z", in_uncached: 300, out_total: 30 });
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const ledgerRows = () => db.query("SELECT row_id,src_hash FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id").all() as
      Array<{ row_id: number; src_hash: string }>;
    const before = new Map(ledgerRows().map(row => [row.row_id, row.src_hash]));
    // A correction moves a call to another day; the only call of a day is deleted.
    db.query("UPDATE claude_events SET ts='2026-09-14T08:00:00.000Z' WHERE call_id='between'").run();
    db.query("DELETE FROM claude_events WHERE call_id='alone'").run();
    const changedDays = db.query(`SELECT r.day FROM fact_day_revisions r WHERE r.source='claude_events' AND r.day<>'*'
      AND r.revision IS NOT (SELECT revision FROM usage_ledger_source_days WHERE provider='claude' AND day=r.day)`).all();
    expect(changedDays.length).toBeLessThanOrEqual(3);
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(usageLedgerState(db, "claude")).toMatchObject({ status: "ready", covered: factTableRevision(db, "claude_events")! });
    // Facts of unchanged rows were not written again.
    const moved = (db.query("SELECT id FROM claude_events WHERE call_id='between'").get() as { id: number }).id;
    for (const row of ledgerRows()) if (row.row_id !== moved) expect(row.src_hash).toBe(before.get(row.row_id)!);
    const incremental = ledgerDays(db, "claude");
    expect(compareDays(incremental, referenceDays(db, "claude", fixture.rates))).toEqual([]);
    const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
    expect(count("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude' AND src_day='2026-09-20'"))
      .toBe(count("SELECT COUNT(*) n FROM claude_events WHERE substr(ts,1,10)='2026-09-20'"));
    discardLedger(db, "claude");
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(ledgerDays(db, "claude")).toEqual(incremental);
  } finally { fixture.teardown(); }
}, 60_000);

test("a day reconciled page by page resumes on a new connection at its row bookmark", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    let db = fixture.db;
    for (let index = 0; index < 5; index++)
      insertClaude(db, { call_id: `page-${index}`, ts: `2026-09-19T0${index}:00:00.000Z`, in_uncached: 100 + index, out_total: 10 });
    // One row per step: the day's pages stop in the middle, with the day's bookmark saved.
    for (let step = 0; step < 3; step++) stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 1);
    expect(JSON.parse((db.query("SELECT bookmark FROM usage_ledger_state WHERE provider='claude'").get() as { bookmark: string }).bookmark))
      .toMatchObject({ day: "2026-09-19" });
    db = new Connection(fixture.dbPath);
    try {
      fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 1);
      expect(usageLedgerState(db, "claude")?.status).toBe("ready");
      expect(compareDays(ledgerDays(db, "claude"), referenceDays(db, "claude", fixture.rates))).toEqual([]);
    } finally { db.close(); }
  } finally { fixture.teardown(); }
}, 60_000);

test("a ledger built while its source was empty fills by backfill once the source arrives, equal to a full refill", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    const reference = ledgerDays(db, "claude");
    // As on a first import: the ledger was built and published while the source had no rows, then every row arrived.
    discardLedger(db, "claude");
    db.query("DELETE FROM usage_ledger_source_days WHERE provider='claude'").run();
    db.query(`INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision,published_revision)
      SELECT 'claude',version,'reconcile','ready',0,'',rules_digest,1,1 FROM usage_ledger_state WHERE provider='gemini'`).run();
    const phases = new Set<string>();
    for (let steps = 0; usageLedgerState(db, "claude")?.status !== "ready" || phases.size === 0; steps++) {
      if (steps > 500) throw new Error("ledger did not fill");
      stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
      phases.add(usageLedgerState(db, "claude")?.phase ?? "none");
    }
    // It went through the backfill and the identity-range resolution, not a day-by-day reconciliation of every row.
    expect(phases.has("backfill") || phases.has("resolve")).toBe(true);
    expect(db.query("SELECT COUNT(*) n FROM usage_ledger_dirty WHERE provider='claude' AND kind='identity'").get()).toEqual({ n: 0 });
    expect(ledgerDays(db, "claude")).toEqual(reference);
  } finally { fixture.teardown(); }
}, 60_000);

test("a step takes as many rows as fit the batch time: a slow step makes the next one smaller, a fast one larger", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  let now = 0, cost = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now += cost);
  try {
    const db = fixture.db;
    discardLedger(db, "claude");
    stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT); // creates the state
    const facts = () => (db.query("SELECT COUNT(*) n FROM usage_ledger_facts WHERE provider='claude'").get() as { n: number }).n;
    const rowsOfNextStep = (stepCost: number) => {
      const before = facts();
      cost = stepCost;
      try { stepUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT, 5); } finally { cost = 0; }
      return facts() - before;
    };
    expect((db.query("SELECT COUNT(*) n FROM claude_events").get() as { n: number }).n).toBeGreaterThan(10);
    // Every clock read advances 100 s: the step looks far slower than BATCH_MS, so the next takes one row;
    // a fast step lets the size grow again, at most twofold.
    expect(rowsOfNextStep(100_000)).toBe(5);
    expect(rowsOfNextStep(0)).toBe(1);
    expect(rowsOfNextStep(0)).toBe(2);
  } finally { clock.mockRestore(); fixture.teardown(); }
}, 60_000);

test("a source emptied by its last writes leaves no sums behind", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    expect(ledgerDays(db, "claude").size).toBeGreaterThan(0);
    db.query("DELETE FROM claude_events").run();
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    expect(ledgerDays(db, "claude").size).toBe(0);
    expect(db.query("SELECT COUNT(*) n FROM usage_ledger_hours WHERE provider='claude'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM usage_activity_intervals WHERE provider='claude'").get()).toEqual({ n: 0 });
  } finally { fixture.teardown(); }
}, 60_000);
