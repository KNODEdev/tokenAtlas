import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { ingestGaugesAsync } from "../src/ingest/gauges";
import { expandProbeJournal } from "../src/providers/core/journal-compact";
import { dailyJournalFile, PROBE_JOURNAL_FILE } from "../src/providers/core/journal-files";
import { openMonitorOutbox, queueMonitorRows, monitorRows, deliverMonitorRows, acquireMonitorLease, releaseMonitorLease, monitorDisplayMeters, monitorJournalTarget, readMonitorCurrent, publishMonitorCurrent, recentMonitorObservation } from "./lib/usage-monitor";
import type { WindowReading } from "../src/providers/types";
import { mainServerPid } from "./lib/usage-monitor";
import { monitorTip } from "./dev/monitor-gauges";
import { readClaudeCredentials } from "../src/providers/adapters/claude";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-monitor-")); dirs.push(root);
  const file = path.join(root, "outbox.sqlite");
  const archiveRoot = path.join(root, "archive");
  const { journalRoot } = monitorJournalTarget(archiveRoot, "fixture-user");
  return { root, file, archiveRoot, journalRoot };
}
const reading: WindowReading = { kind: "primary", group: "codex", scope: null, plan: "pro", reportedPercentSide: "used",
  usedPercent: 42.25, remainingPercent: null, vendorPercent: 42.25, windowMinutes: 300, allowance: null, used: null,
  remaining: null, resetsAt: "2026-10-15T00:00:00Z", rateLimitReached: false, resetCredits: 2,
  profile: null, ok: true, error: null, extra: { witness: "synthetic" } };
const source = { machine: "fixture", login: "user", home: "C:/fixture/.codex" };
const ts = "2026-10-14T12:00:00.000Z";

test("Unix main detector matches an exact entrypoint even with punctuation and spaces", () => {
  for (const root of ["/home/a/token.atlas", "/home/a/token(atlas)", "/home/a/token[atlas]", "/home/a/token atlas"]) {
    const entry=`${root}/src/server/api.ts`;
    expect(mainServerPid(`123 bun '${entry}' --atlas-server-child`,entry)).toBe(123);
    expect(mainServerPid(`123 bun ${root}/TMP/worktree/src/server/api.ts --atlas-server-child`,entry)).toBeNull();
    expect(mainServerPid(`123 bun '${entry}' --atlas-server-child-other`,entry)).toBeNull();
    expect(mainServerPid(`123 bun ${root.replace("atlas","other")}/src/server/api.ts --atlas-server-child`,entry)).toBeNull();
  }
});
test("collector tip binds verified identity and source subject and retains a 30-day meter", () => {
  const f=fixture();const db=openMonitorOutbox(f.file);
  const rows=monitorRows("codex","minted",ts,[{...reading,windowMinutes:43200,extra:{codex_account:JSON.stringify({key:"verified"})}}],source);
  const fact=queueMonitorRows(db,f,rows)[0]!;
  const selected=[{id:"codex:declared",provider:"codex" as const,key:"verified",subject:"minted"}];
  expect(monitorTip(fact,selected,{windows:[]})).toMatchObject({account:"codex:declared",at:Date.parse(ts),counter_id:fact.counter_id,
    meter:{kind:"codex",group:"codex",minutes:43200,percent:42.25}});
  expect(monitorTip(fact,[{...selected[0]!,key:"other"}],{windows:[]})).toBeNull();
  expect(monitorTip(fact,[{...selected[0]!,subject:"other"}],{windows:[]})).toBeNull();db.close();
});
test("a malformed credential diagnostic cannot persist an excerpt of credential contents", () => {
  const f=fixture();const sentinel="synthetic-secret-never-in-errors";
  fs.writeFileSync(path.join(f.root,".credentials.json"),`{"accessToken":${sentinel}`);
  const result=readClaudeCredentials(f.root);
  expect(result).toEqual({creds:null,error:"poświadczenia nieczytelne"});
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test("Codex primary may be weekly or 30-day; slot order never selects the 5h column", () => {
  const weekly = monitorDisplayMeters("codex", [{ ...reading, kind: "primary", windowMinutes: 10080 }]);
  expect(weekly[0]).toMatchObject({ kind: "primary", hours: 168, accountWide: true });
  const reversed = monitorDisplayMeters("codex", [
    { ...reading, kind: "primary", windowMinutes: 10080 },
    { ...reading, kind: "secondary", windowMinutes: 300 },
    { ...reading, kind: "primary", windowMinutes: 43200 },
    { ...reading, kind: "primary", windowMinutes: null },
    { ...reading, group: "base_model_inference", windowMinutes: 10080 },
  ]);
  expect(reversed.map(r => [r.hours, r.accountWide])).toEqual([[168,true],[5,true],[720,true],[null,true],[168,false]]);
});

test("Claude uses its counter kinds and keeps the model-scoped week separate from the whole account", () => {
  const meters = monitorDisplayMeters("claude", [
    { ...reading, kind: "session", group: "session", windowMinutes: null },
    { ...reading, kind: "weekly_all", group: "weekly", windowMinutes: null },
    { ...reading, kind: "weekly_scoped", group: "weekly", scope: "Fable", usedPercent: 0, windowMinutes: null },
  ]);
  expect(meters.map(r=>[r.hours,r.accountWide,r.percent,r.scope])).toEqual([[5,true,42.25,null],[168,true,42.25,null],[168,false,0,"Fable"]]);
});

test("durable outbox retains percentages and canonical provenance through outage, restart and delivery", () => {
  const f = fixture(); let db = openMonitorOutbox(f.file);
  queueMonitorRows(db, f, monitorRows("codex", "account", ts, [reading], source));
  expect(deliverMonitorRows(db)).toEqual({ delivered: 0, pending: 1, errors: ["archive-unavailable"] });
  db.close(); db = openMonitorOutbox(f.file);
  fs.mkdirSync(f.archiveRoot);
  expect(deliverMonitorRows(db)).toEqual({ delivered: 1, pending: 0, errors: [] });
  expect(deliverMonitorRows(db)).toEqual({ delivered: 0, pending: 0, errors: [] });
  const rows = expandProbeJournal(fs.readFileSync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())), "utf8").trim().split("\n"));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ used_percent: 42.25, ts, machine: "fixture", login: "user", source_home: source.home, reset_credits: 2 });
  expect((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name).sort())
    .toEqual(["gauge_journal_outbox","monitor_current","monitor_lease","monitor_publication"]);
  expect(readMonitorCurrent(db)[0]![0]!.payload.used_percent).toBe(42.25);
  db.close();
});

test("real gauge importer accepts both providers, repeated readings, and identical replay without duplicate facts", async () => {
  const f = fixture(); fs.mkdirSync(f.archiveRoot);
  const outbox = openMonitorOutbox(f.file);
  const expected = [];
  for (const provider of ["codex", "claude"] as const) {
    for (const time of [ts, "2026-10-14T12:20:00.000Z"]) {
      const counters = provider === "codex" ? [
        { ...reading, kind: "primary", windowMinutes: 10080 },
        { ...reading, kind: "secondary", windowMinutes: 300 },
      ] : [
        { ...reading, kind: "session", group: "session", windowMinutes: null },
        { ...reading, kind: "weekly_all", group: "weekly", windowMinutes: null },
        { ...reading, kind: "weekly_scoped", group: "weekly", scope: "Fable", windowMinutes: null },
      ];
      const rows = monitorRows(provider, `${provider}-fixture`, time, counters, source);
      expected.push(...rows);
      queueMonitorRows(outbox, f, rows);
      if (provider === "codex") {
        const monthly = monitorRows(provider, "codex-monthly", time, [{ ...reading, windowMinutes: 43200 }], source);
        expected.push(...monthly); queueMonitorRows(outbox, f, monthly);
      }
    }
  }
  expect(deliverMonitorRows(outbox).delivered).toBe(12); outbox.close();
  const target = path.join(f.root, "receiver.sqlite");
  const db = new Database(target, { create: true }); applyDrizzleMigrations(drizzle(db)); db.close();
  await ingestGaugesAsync({ archiveRoot: f.archiveRoot, atlasPath: target, force: false, ownStore: "fixture-user" });
  await ingestGaugesAsync({ archiveRoot: f.archiveRoot, atlasPath: target, force: true });
  const received = new Database(target, { readonly: true });
  const sort = (a: {provider:string;subject:string;ts:string;kind:string}, b: typeof a) => a.provider.localeCompare(b.provider)
    || a.subject.localeCompare(b.subject) || a.ts.localeCompare(b.ts) || a.kind.localeCompare(b.kind);
  const actual = received.query("SELECT provider,subject,ts,kind,limit_group,scope,window_minutes,used_percent,resets_at,machine,extra FROM probe_windows").all();
  expect((actual as Array<{provider:string;subject:string;ts:string;kind:string}>).sort(sort)).toEqual(expected.sort(sort)
    .map(({provider,subject,ts,kind,limit_group,scope,window_minutes,used_percent,resets_at,machine,extra}) =>
      ({provider,subject,ts,kind,limit_group,scope,window_minutes,used_percent,resets_at,machine,extra})));
  expect(received.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 12 }); received.close();
});

test("lease excludes overlapping collectors, does not allow another owner to release it, and recovers after a crash", () => {
  const f = fixture(); const a = openMonitorOutbox(f.file); const b = openMonitorOutbox(f.file);
  expect(acquireMonitorLease(a, "a", 1000)).toBe(true);
  expect(acquireMonitorLease(b, "b", 1001)).toBe(false);
  releaseMonitorLease(b, "b"); expect(acquireMonitorLease(b, "b", 1002)).toBe(false);
  releaseMonitorLease(a, "a"); expect(acquireMonitorLease(b, "b", 1002)).toBe(true);
  expect(acquireMonitorLease(a, "a", 601003)).toBe(false);
  expect(acquireMonitorLease(a, "a", 601003,()=>false)).toBe(true);
  a.close(); b.close();
});

test("only complete exact archive acknowledgments publish current readings, including crash recovery", () => {
  const f = fixture(); let db = openMonitorOutbox(f.file);
  const now = new Date().toISOString();
  const facts = queueMonitorRows(db, f, monitorRows("codex", "account", now, [reading, { ...reading, kind: "secondary", windowMinutes: 10080 }], source));
  expect(recentMonitorObservation(db, "codex", "account", 20)).toBe(true);
  publishMonitorCurrent(db); expect(readMonitorCurrent(db)).toEqual([]);
  const entries = db.query("SELECT entry_id FROM gauge_journal_outbox ORDER BY id").all() as Array<{entry_id:string}>;
  // Simulate acknowledgments from the archive writer, then a crash before publication.
  db.query("DELETE FROM gauge_journal_outbox WHERE entry_id=?").run(entries[0]!.entry_id);
  publishMonitorCurrent(db); expect(readMonitorCurrent(db)).toEqual([]);
  db.query("DELETE FROM gauge_journal_outbox WHERE entry_id=?").run(entries[1]!.entry_id);
  db.close(); db = openMonitorOutbox(f.file);
  publishMonitorCurrent(db);
  expect(readMonitorCurrent(db)).toEqual([facts]);
  queueMonitorRows(db, f, monitorRows("codex", "account", ts, [{ ...reading, usedPercent: 1 }], source));
  db.query("DELETE FROM gauge_journal_outbox").run(); publishMonitorCurrent(db);
  expect(readMonitorCurrent(db)).toEqual([facts]);
  expect(db.query("SELECT count(*) n FROM monitor_publication").get()).toEqual({n:0});
  db.close();
});

test("publication bounds acknowledged batches and current reads filter selected subjects", () => {
  const f=fixture();const db=openMonitorOutbox(f.file);
  for(let i=0;i<25;i++) queueMonitorRows(db,f,monitorRows("codex",`seat-${i}`,ts,[reading],source));
  db.query("DELETE FROM gauge_journal_outbox").run();
  publishMonitorCurrent(db);
  expect(db.query("SELECT count(*) n FROM monitor_publication").get()).toEqual({n:9});
  expect(readMonitorCurrent(db,["codex:seat-0","claude:seat-1"])).toHaveLength(1);
  expect(readMonitorCurrent(db,[])).toEqual([]);
  publishMonitorCurrent(db);expect(readMonitorCurrent(db)).toHaveLength(25);
  db.close();
});

test("an outage backlog publishes each account's newest acknowledged observation first", () => {
  const f=fixture();const db=openMonitorOutbox(f.file);
  for(let i=0;i<300;i++) queueMonitorRows(db,f,monitorRows("codex","seat",new Date(Date.parse(ts)+i*60000).toISOString(),
    [{...reading,usedPercent:i/3}],source));
  queueMonitorRows(db,f,monitorRows("claude","other",ts,[reading],source));
  db.query("DELETE FROM gauge_journal_outbox").run();
  publishMonitorCurrent(db);
  const facts=readMonitorCurrent(db);
  expect(facts).toHaveLength(2);
  expect(facts.find(f=>f[0]!.header.provider==="codex")![0]!.payload.used_percent).toBe(299/3);
  expect(db.query("SELECT count(*) n FROM monitor_publication").get()).toEqual({n:43});
  expect(deliverMonitorRows(db).pending).toBe(0);db.close();
});

test("a changed archive location does not redirect pending evidence away from its original target", () => {
  const f = fixture(); const db = openMonitorOutbox(f.file);
  const other = { archiveRoot: path.join(f.root, "other"), journalRoot: path.join(f.root, "other", "gauges", "fixture-user") };
  queueMonitorRows(db, f, monitorRows("codex", "first", ts, [reading], source));
  queueMonitorRows(db, other, monitorRows("claude", "second", ts, [reading], source));
  fs.mkdirSync(other.archiveRoot);
  expect(deliverMonitorRows(db)).toEqual({ delivered: 1, pending: 1, errors: ["archive-unavailable"] });
  fs.mkdirSync(f.archiveRoot);
  expect(deliverMonitorRows(db)).toEqual({ delivered: 1, pending: 0, errors: [] }); db.close();
});

test("handoff finishes the independent journal but retains legacy work targeting the main writer's file", () => {
  const f = fixture(); const db = openMonitorOutbox(f.file); fs.mkdirSync(f.archiveRoot);
  const main = { archiveRoot:f.archiveRoot, journalRoot:path.join(f.archiveRoot,"gauges","fixture-user") };
  queueMonitorRows(db, main, monitorRows("codex", "legacy", ts, [reading], source));
  queueMonitorRows(db, f, monitorRows("claude", "completed", ts, [reading], source));
  expect(deliverMonitorRows(db,t=>t.journalRoot!==main.journalRoot)).toEqual({delivered:1,pending:1,errors:[]});
  expect(fs.existsSync(main.journalRoot)).toBe(false);
  db.close();
  const reopened=openMonitorOutbox(f.file);
  expect(deliverMonitorRows(reopened)).toEqual({delivered:1,pending:0,errors:[]}); reopened.close();
});
