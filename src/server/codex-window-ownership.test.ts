import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { excludeConflictingWindowSamples as readWindowProtection } from "./codex-window-ownership";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { readFileSync } from "node:fs";

const sources = ["main","other","third"].map(id=>probeReaderFixtureSource("codex",id));
function excludeConflictingWindowSamples(...args: Parameters<typeof readWindowProtection>) {
  if (args[0].query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='probe_windows'").get())
    prepareProbeReaderFixture(args[0] as Database,sources,row=>row.subject === "old-target" ? "main" : row.subject);
  return readWindowProtection(...args);
}

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const first = "2026-09-09T18:33:23.000Z";
const last = "2026-09-10T10:19:47.000Z";
const ownReset = "2026-09-15T21:06:09.000Z";
const foreignReset = "2026-09-16T14:59:47.000Z";
const samples = [
  { ts: "2026-09-09T18:41:30.796Z", resets_at: Date.parse(foreignReset) / 1000, limit_id: "codex" },
  { ts: "2026-09-09T18:41:31.673Z", resets_at: Date.parse(foreignReset) / 1000, limit_id: "codex" },
];
function database() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`CREATE TABLE probe_windows (
    subject TEXT, ts TEXT, resets_at TEXT, extra TEXT, provider TEXT DEFAULT 'codex', kind TEXT DEFAULT 'primary',
    window_minutes INTEGER DEFAULT 10080, limit_group TEXT DEFAULT 'codex', ok INTEGER
  )`);
  return db;
}
function probe(db: Database, subject: string, ts: string, reset: string, verified = true) {
  db.run("INSERT INTO probe_windows (subject,ts,resets_at,extra) VALUES (?,?,?,?)",
    [subject, ts, reset, JSON.stringify({ codex_account: verified
      ? JSON.stringify({ subscription: subject, account_id: subject + "-vendor-id" }) : null })]);
}
function setup() {
  const db = database();
  probe(db, "main", first, ownReset);
  probe(db, "main", last, ownReset);
  probe(db, "other", first, foreignReset);
  return db;
}
describe("Codex window identity protection", () => {
  it("excludes both foreign samples without deleting raw facts or shortening the continuing account window", () => {
    const db = setup();
    const legitimate = { ...samples[0]!, resets_at: Date.parse(ownReset) / 1000 };
    const result = excludeConflictingWindowSamples(db, "main", 10080, [legitimate, ...samples]);
    expect(result).toEqual({ samples: [legitimate], excluded: 2 });
    expect(samples).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS n FROM probe_windows").get()).toEqual({ n: 3 });
  });
  it("keeps an actual early reset when the later verified reading confirms it", () => {
    const db = database();
    probe(db, "main", first, ownReset);
    probe(db, "main", last, foreignReset);
    probe(db, "other", first, foreignReset);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
  });
  it("does not use a coincident foreign reset alone as proof", () => {
    const db = database();
    probe(db, "other", first, foreignReset);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
    probe(db, "main", first, ownReset);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
  });
  it("keeps a legitimate sample when both accounts share its reset", () => {
    const db = setup();
    const same = samples.map(s => ({ ...s, resets_at: Date.parse(ownReset) / 1000 }));
    probe(db, "other", first, ownReset);
    expect(excludeConflictingWindowSamples(db, "main", 10080, same).excluded).toBe(0);
  });
  it("ignores unverified, failed and different counter evidence", () => {
    for (const mutation of [
      "UPDATE probe_windows SET extra='{}' WHERE subject='other'",
      "UPDATE probe_windows SET ok=0 WHERE subject='other'",
      "UPDATE probe_windows SET limit_group='codex_bengalfox' WHERE subject='other'",
      "UPDATE probe_windows SET window_minutes=300 WHERE subject='other'",
      "UPDATE probe_windows SET provider='claude' WHERE subject='other'",
    ]) {
      const db = setup(); db.exec(mutation);
      expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
    }
    expect(excludeConflictingWindowSamples(setup(), "main", 10080,
      samples.map(s => ({ ...s, limit_id: "codex_bengalfox" }))).excluded).toBe(0);
  });
  it("uses physical periods despite a stale stamp and follows a corrected account without rewriting originals", () => {
    const db=setup();
    expect(excludeConflictingWindowSamples(db,"main",10080,samples).excluded).toBe(2);
    db.exec("UPDATE probe_windows SET subject='old-target' WHERE subject='main'");
    const original=db.query("SELECT subject,ts,extra FROM probe_windows ORDER BY id").all();
    expect(excludeConflictingWindowSamples(db,"main",10080,samples).excluded).toBe(2);
    const periods=loadPeriods(db,ACCOUNT_PERIODS).filter(p=>p.origin==="declared");
    replaceDeclaredPeriods(db,ACCOUNT_PERIODS,periods.map(p=>p.value==="main"?{...p,value:"moved"}:p));
    expect(excludeConflictingWindowSamples(db,"moved",10080,samples).excluded).toBe(2);
    expect(excludeConflictingWindowSamples(db,"main",10080,samples).excluded).toBe(0);
    expect(db.query("SELECT subject,ts,extra FROM probe_windows ORDER BY id").all()).toEqual(original);
  });
  it("preserves evidence when ownership is ambiguous or readings are too far apart", () => {
    const db = setup(); probe(db, "third", first, foreignReset);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
    db.exec("DELETE FROM probe_windows WHERE subject='third'");
    db.run("UPDATE probe_windows SET ts='2026-09-11T18:00:00.000Z' WHERE ts=?", [last]);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
  });
  it("supports legacy indexes without probe identity facts", () => {
    const db = new Database(":memory:"); databases.push(db);
    expect(excludeConflictingWindowSamples(db, "main", 10080, samples).excluded).toBe(0);
  });
});
