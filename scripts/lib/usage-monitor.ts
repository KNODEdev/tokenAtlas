import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { createProbeCollection, validateCanonicalProbe, type CanonicalProbe } from "../../src/db/probe-facts";
import { compactProbeLine } from "../../src/providers/core/journal-compact";
import { PROBE_JOURNAL_FILE, flushGaugeJournal, type ProbeJournalRow, type JournalDeliveryTarget } from "../../src/providers/core/journal";
import type { WindowReading } from "../../src/providers/types";
import { railWindowHours } from "../../src/server/claude-declared-windows";
import { execFile } from "node:child_process";
import path from "node:path";

export function mainServerPid(stdout: string, entry: string): number | null {
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!row || !/(?:^|\s)--atlas-server-child(?:\s|$)/.test(row[2]!)) continue;
    const command = row[2]!;
    const at = command.indexOf(entry), end = at + entry.length;
    if (at >= 0 && (at === 0 || /[\s"']/.test(command[at-1]!))
      && (end === command.length || /[\s"']/.test(command[end]!))) return Number(row[1]);
  }
  return null;
}

/** Read-only process detection shared with the corner window; never reads the live database. */
export function mainAppStatus(): Promise<{running:boolean;pid:number|null}> {
  if (process.platform !== "win32") {
    const entry = path.resolve(import.meta.dir,"../../src/server/api.ts");
    return new Promise((resolve,reject)=>execFile("ps",["-eo","pid=,args="],{timeout:5000},(error,stdout)=>{
      if(error) {reject(new Error("Nie można sprawdzić głównej aplikacji"));return;}
      const pid = mainServerPid(stdout, entry);
      resolve({running:pid != null,pid});
    }));
  }
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.resolve(import.meta.dir, "..", "usage-monitor-main.ps1"), "-Check"],
    { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) { reject(new Error("Nie można sprawdzić, czy główny tokenAtlas działa")); return; }
      try {
        const result = JSON.parse(stdout);
        if (typeof result.running !== "boolean") throw new Error("Invalid detector result");
        resolve({running:result.running,pid:Number.isSafeInteger(result.pid)&&result.pid>0 ? result.pid:null});
      } catch { reject(new Error("Nie można sprawdzić, czy główny tokenAtlas działa")); }
    });
  });
}
export async function mainAppRunning(): Promise<boolean> { return (await mainAppStatus()).running; }

export function monitorJournalTarget(archiveRoot: string, profile: string) {
  return { archiveRoot, journalRoot: path.join(archiveRoot, "gauges", `${profile}-usage-monitor`) };
}

/** The same duration contract the application's window rail uses; slots are not durations. */
export function monitorDisplayMeters(provider: "codex" | "claude", readings: readonly WindowReading[]) {
  return readings.map(r => ({ kind: r.kind, group: r.group, scope: r.scope, percent: r.usedPercent,
    hours: railWindowHours(provider, r.kind, r.windowMinutes),
    accountWide: r.scope == null && (provider === "codex" ? r.group === "codex"
      : r.kind === "session" || r.kind === "weekly_all") }));
}

// A durable transport outbox only; never an application database or analytical register.
export function openMonitorOutbox(file: string): Database {
  const db = new Database(file, { create: true });
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS gauge_journal_outbox (
      id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, journal_root TEXT NOT NULL,
      archive_root TEXT, file_name TEXT NOT NULL, payload TEXT NOT NULL, queued_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitor_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER, pid INTEGER);
    CREATE TABLE IF NOT EXISTS monitor_publication (id TEXT PRIMARY KEY,payload TEXT NOT NULL,entry_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitor_current (provider TEXT NOT NULL,subject TEXT NOT NULL,ts TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(provider,subject));
    CREATE INDEX IF NOT EXISTS monitor_publication_account ON monitor_publication(json_extract(payload,'$[0].header.provider'),json_extract(payload,'$[0].header.subject'),json_extract(payload,'$[0].header.ts'));
    INSERT OR IGNORE INTO monitor_lease(id,owner,until_ms) VALUES(1,NULL,0);`);
  if (!(db.query("PRAGMA table_info(monitor_lease)").all() as Array<{name:string}>).some(column=>column.name==="pid")) db.exec("ALTER TABLE monitor_lease ADD COLUMN pid INTEGER");
  return db;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid,0); return true; }
  catch(error) { return (error as NodeJS.ErrnoException).code!=="ESRCH"; }
}
export function acquireMonitorLease(db: Database, owner: string, now = Date.now(), alive = processAlive): boolean {
  return db.transaction(()=>{
    const row=db.query("SELECT owner,until_ms,pid FROM monitor_lease WHERE id=1").get() as {owner:string|null;until_ms:number;pid:number|null};
    if(row.owner && (row.pid == null ? row.until_ms>now : alive(row.pid))) return false;
    db.query("UPDATE monitor_lease SET owner=?,until_ms=?,pid=? WHERE id=1").run(owner,now+10*60_000,process.pid);
    return true;
  }).immediate();
}

export function releaseMonitorLease(db: Database, owner: string): void {
  db.query("UPDATE monitor_lease SET owner=NULL,until_ms=0,pid=NULL WHERE id=1 AND owner=?").run(owner);
}

export function monitorRows(provider: "codex" | "claude", subject: string, ts: string,
  readings: WindowReading[], source: { machine: string; login: string; home: string }): ProbeJournalRow[] {
  return readings.map(r => ({ provider, subject, ts, plan: r.plan, kind: r.kind, limit_group: r.group,
    scope: r.scope, reported_percent_side: r.reportedPercentSide, used_percent: r.usedPercent,
    remaining_percent: r.remainingPercent, vendor_percent: r.vendorPercent, window_minutes: r.windowMinutes,
    allowance: r.allowance, used: r.used, remaining: r.remaining, resets_at: r.resetsAt,
    rate_limit_reached: r.rateLimitReached == null ? null : Number(r.rateLimitReached), reset_credits: r.resetCredits,
    profile: r.profile ?? source.login, ok: r.ok == null ? null : Number(r.ok), error: r.error,
    extra: JSON.stringify({ ...r.extra, home: source.home }), machine: source.machine, login: source.login,
    source_home: source.home, raw_subject: subject }));
}

export function queueMonitorRows(db: Database, target: JournalDeliveryTarget, rows: ProbeJournalRow[]): CanonicalProbe[] {
  const facts = createProbeCollection(rows.map(row => ({ ...row })));
  if (!facts.length) return [];
  const insert = db.query(`INSERT INTO gauge_journal_outbox
    (entry_id,journal_root,archive_root,file_name,payload,queued_at) VALUES(?,?,?,?,?,?)`);
  db.transaction(() => {
    const entries: string[] = [];
    for (const fact of facts) {
      const id = randomUUID();
      const payload = compactProbeLine(id, fact, null).line;
      if (Buffer.byteLength(payload) > 64 * 1024) throw new Error("Monitor journal entry exceeds 64 KiB");
      insert.run(id, target.journalRoot, target.archiveRoot, PROBE_JOURNAL_FILE, payload, new Date().toISOString());
      entries.push(id);
    }
    db.query("INSERT INTO monitor_publication VALUES(?,?,?)").run(facts[0]!.observation_id,JSON.stringify(facts),JSON.stringify(entries));
  }).immediate();
  return facts;
}

/** One disposable current projection per account, published only after every exact journal entry is acknowledged. */
export function publishMonitorCurrent(db: Database): void {
  db.transaction(() => {
    const acknowledged = `NOT EXISTS (SELECT 1 FROM json_each(p.entry_ids) e JOIN gauge_journal_outbox o ON o.entry_id=e.value)`;
    // MAX chooses the id of the newest acknowledged observation in each account.
    // Read payloads only after that reduction; an outage backlog never enters JS memory.
    const pending = db.query(`SELECT id,payload FROM monitor_publication WHERE id IN
      (SELECT id FROM monitor_publication p WHERE ${acknowledged} AND NOT EXISTS
        (SELECT 1 FROM monitor_current c WHERE c.provider=json_extract(p.payload,'$[0].header.provider')
          AND c.subject=json_extract(p.payload,'$[0].header.subject') AND c.ts>=json_extract(p.payload,'$[0].header.ts'))
       GROUP BY json_extract(payload,'$[0].header.provider'),json_extract(payload,'$[0].header.subject')
       HAVING MAX(json_extract(payload,'$[0].header.ts')) IS NOT NULL LIMIT 16)`)
      .all() as Array<{id:string;payload:string}>;
    for (const row of pending) {
      const facts = (JSON.parse(row.payload) as unknown[]).map(value=>validateCanonicalProbe(value));
      const header = facts[0]!.header;
      db.query(`INSERT INTO monitor_current VALUES(?,?,?,?) ON CONFLICT(provider,subject) DO UPDATE
        SET ts=excluded.ts,payload=excluded.payload WHERE excluded.ts>=monitor_current.ts`)
        .run(header.provider,header.subject,header.ts,JSON.stringify(facts));
      db.query("DELETE FROM monitor_publication WHERE id=?").run(row.id);
    }
    db.query(`DELETE FROM monitor_publication WHERE id IN (SELECT p.id FROM monitor_publication p
      JOIN monitor_current c ON c.provider=json_extract(p.payload,'$[0].header.provider')
        AND c.subject=json_extract(p.payload,'$[0].header.subject') AND c.ts>=json_extract(p.payload,'$[0].header.ts')
      WHERE ${acknowledged} LIMIT 256)`).run();
  }).immediate();
}
export function readMonitorCurrent(db: Database, subjects?: readonly string[]): CanonicalProbe[][] {
  return (db.query(`SELECT payload FROM monitor_current${subjects ? " WHERE (provider,subject) IN (SELECT substr(value,1,instr(value,':')-1),substr(value,instr(value,':')+1) FROM json_each(?))" : ""} ORDER BY provider,subject`)
    .all(...(subjects ? [JSON.stringify(subjects)] : [])) as Array<{payload:string}>)
    .map(row=>(JSON.parse(row.payload) as unknown[]).map(value=>validateCanonicalProbe(value)));
}
export function recentMonitorObservation(db: Database, provider: string, subject: string, intervalMinutes: number): boolean {
  const row=db.query(`SELECT ts FROM monitor_current WHERE provider=?1 AND subject=?2 UNION ALL
    SELECT json_extract(payload,'$[0].header.ts') AS ts FROM monitor_publication
    WHERE json_extract(payload,'$[0].header.provider')=?1 AND json_extract(payload,'$[0].header.subject')=?2
    ORDER BY ts DESC LIMIT 1`).get(provider,subject) as {ts:string}|null;
  return row!=null && Date.now()-Date.parse(row.ts)<intervalMinutes*60_000;
}

export function deliverMonitorRows(db: Database, allowed: (target: JournalDeliveryTarget) => boolean = () => true): { delivered: number; pending: number; errors: string[] } {
  // Retry each original target, including observations queued before a location change.
  const targets = db.query("SELECT DISTINCT journal_root,archive_root FROM gauge_journal_outbox")
    .all() as { journal_root: string; archive_root: string | null }[];
  let delivered = 0;
  const errors: string[] = [];
  for (const t of targets) {
    if (!allowed({ journalRoot: t.journal_root, archiveRoot: t.archive_root })) continue;
    for (let turn = 0; turn < 256; turn++) {
      const result = flushGaugeJournal(db, { journalRoot: t.journal_root, archiveRoot: t.archive_root });
      delivered += result.delivered;
      if (result.error) { errors.push(result.error); break; }
      if (result.delivered === 0) break;
    }
  }
  publishMonitorCurrent(db);
  const pending = (db.query(`SELECT (SELECT count(*) FROM gauge_journal_outbox)+
    (SELECT count(*) FROM monitor_publication p WHERE NOT EXISTS
      (SELECT 1 FROM json_each(p.entry_ids) e JOIN gauge_journal_outbox o ON o.entry_id=e.value)) AS n`)
    .get() as {n:number}).n;
  return { delivered, pending, errors };
}
