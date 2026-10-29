import type { Database } from "./sqlite";
import { LONG_CALL_OUT, TIMED_SUMS, type TimedSums } from "./usage-ledger";
import { subscriptionAccountingAdapters } from "../server/subscription-accounting-adapters";
import { recordedEffort } from "../shared/model-execution";
import { MODEL_SPEED_QUEUE_TRACKING_SCHEMA, modelSpeedQueueBatch, modelSpeedQueueRemaining, promoteTimingWork, timingQueueClock, recordModelSpeedService } from "./model-speed-queue";

/** A timing projection of accepted ledger calls. It neither deduplicates nor values source events. */
export const MODEL_SPEED_SCHEMA = `
CREATE TABLE model_speed_state(provider TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE model_speed_queue(provider TEXT NOT NULL,event_id INTEGER NOT NULL,priority INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(provider,event_id));
${MODEL_SPEED_QUEUE_TRACKING_SCHEMA}
CREATE TABLE model_speed_facts(
  provider TEXT NOT NULL,event_id INTEGER NOT NULL,key TEXT NOT NULL,source TEXT,identity TEXT,model TEXT,
  speed TEXT,effort TEXT,service_tier TEXT,billing TEXT,ts TEXT NOT NULL,hour INTEGER NOT NULL,
  calls INTEGER NOT NULL,${TIMED_SUMS.map(c => `${c} INTEGER NOT NULL`).join(",")},PRIMARY KEY(provider,event_id));
CREATE INDEX model_speed_facts_boundary ON model_speed_facts(provider,key,hour,ts);
CREATE TABLE model_speed_hours(
  provider TEXT NOT NULL,key TEXT NOT NULL,source TEXT,identity TEXT,model TEXT,speed TEXT,effort TEXT,service_tier TEXT,billing TEXT,
  hour INTEGER NOT NULL,calls INTEGER NOT NULL,${TIMED_SUMS.map(c => `${c} INTEGER NOT NULL`).join(",")},PRIMARY KEY(provider,key,hour));
`;
export const hasModelSpeedSchema = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE name='model_speed_state'").get();
const columnsOf = (db: Database, table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
const measures = ["calls", ...TIMED_SUMS] as const;
const dimensions = ["source", "identity", "model", "speed", "effort", "service_tier", "billing"] as const;
const factColumns = ["provider", "event_id", "key", ...dimensions, "ts", "hour", ...measures] as const;
export interface ModelSpeedFact extends TimedSums {
  provider: string; event_id: number; key: string; source: string | null; identity: string | null; model: string | null;
  speed: string | null; effort: string | null; service_tier: string | null; billing: string | null; ts: string; hour: number; calls: number;
}

export function installModelSpeedTracking(db: Database): void {
  if (!hasModelSpeedSchema(db) || !columnsOf(db, "model_speed_queue").has("priority")) return;
  const providers = [{ id: "codex", table: "codex_price_ledger_events", raw: "events", key: "id" },
    ...subscriptionAccountingAdapters().map(a => ({ id: a.id, table: "usage_ledger_facts", raw: a.table, key: "row_id" }))];
  for (const p of providers) {
    if (!/^[a-z][a-z0-9_]*$/.test(p.id) || !/^[a-z][a-z0-9_]*$/.test(p.raw)) throw new Error("Invalid timing provider");
    const columns = columnsOf(db, p.table);
    if (!columns.has("resp_ms")) continue;
    const initialized = !!db.query("SELECT 1 FROM model_speed_state WHERE provider=?").get(p.id);
    const triggers = new Map<string, string>();
    const own = (side: string) => p.id === "codex" ? "1" : `${side}.provider='${p.id}'`;
    // An outer ledger UPSERT overrides OR IGNORE in triggers; an explicit conflict target stays idempotent.
    const enqueue = (side: string) => `INSERT INTO model_speed_queue(provider,event_id,priority,queued_at)
      SELECT '${p.id}',${side}.${p.key},1,${timingQueueClock} WHERE ${own(side)} ${promoteTimingWork};`;
    const watched = (p.id === "codex" ? ["dim_id", "ts", "instant_ms", "admitted", "copy_state", "output", "resp_ms", "common_reason", "invalid_tokens"]
      : ["dim_id", "ts", "accounting", "copy_state", "source", "account_key", "model", "speed", "q_out", "resp_ms", "usage_valid", "billing_mode"])
      .filter(c => columns.has(c));
    for (const op of ["insert", "update", "delete"]) triggers.set(`model_speed_${p.id}_${op}`, `CREATE TRIGGER model_speed_${p.id}_${op} AFTER ${op.toUpperCase()} ON ${p.table}
      ${op === "update" ? `WHEN (${watched.map(c => `OLD.${c}`).join(",")}) IS NOT (${watched.map(c => `NEW.${c}`).join(",")})` : ""}
      BEGIN ${op !== "insert" ? enqueue("OLD") : ""}${op !== "delete" ? enqueue("NEW") : ""} END`);
    // Effort does not affect the money ledger's dimensions, so its source corrections have their own notification.
    if (columnsOf(db, p.raw).has("effort")) for (const op of ["insert", "update", "delete"]) {
      const side = op === "delete" ? "OLD" : "NEW";
      const select = p.id === "codex" ? `SELECT 'codex',e.id,1,${timingQueueClock} FROM codex_price_ledger_events e
        JOIN codex_price_ledger_copies c ON c.id=e.copy_id WHERE c.home IS ${side}.home AND c.path=${side}.path AND e.source_offset=${side}.source_offset`
        : `SELECT '${p.id}',row_id,1,${timingQueueClock} FROM usage_ledger_facts WHERE provider='${p.id}' AND row_id=${side}.id`;
      triggers.set(`model_speed_${p.id}_effort_${op}`, `CREATE TRIGGER model_speed_${p.id}_effort_${op} AFTER ${op === "update" ? "UPDATE OF effort" : op.toUpperCase()} ON ${p.raw}
        ${op === "update" ? "WHEN OLD.effort IS NOT NEW.effort" : ""} BEGIN INSERT INTO model_speed_queue(provider,event_id,priority,queued_at) ${select} ${promoteTimingWork}; END`);
    }
    const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const repairs = [...triggers].filter(([name, sql]) => {
      const stored = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
      return !stored || normalized(stored.sql) !== normalized(sql);
    });
    if (initialized && !repairs.length) continue;
    db.transaction(() => {
      for (const [name, sql] of repairs) { db.exec(`DROP TRIGGER IF EXISTS ${name}`); db.exec(sql); }
      if (initialized) return;
      db.exec(`INSERT OR IGNORE INTO model_speed_queue(provider,event_id) SELECT '${p.id}',${p.key} FROM ${p.table} ${p.id === "codex" ? "" : `WHERE provider='${p.id}'`}`);
      db.query("INSERT INTO model_speed_state(provider) VALUES (?)").run(p.id);
    }).immediate();
  }
}

function project(db: Database, provider: string, id: number, previous: ModelSpeedFact | null,
  rawColumns: (table: string) => Set<string>): ModelSpeedFact | null {
  let row: Record<string, any> | null;
  let effort: unknown;
  if (provider === "codex") {
    row = db.query(`SELECT d.source,NULL identity,d.model,d.speed,d.service_tier,d.billing_mode billing,
      e.ts,e.instant_ms,e.output output,e.resp_ms,e.invalid_tokens=0 valid,c.home,c.path,e.source_offset
      FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id
      JOIN codex_price_ledger_copies c ON c.id=e.copy_id WHERE e.id=? AND e.admitted=1 AND e.copy_state='canonical'`).get(id) as typeof row;
    if (!row) return null;
    if (rawColumns("events").has("effort")) {
      const raw = db.query("SELECT effort FROM events WHERE home IS ? AND path=? AND source_offset=? LIMIT 1")
        .get(row.home, row.path, row.source_offset) as { effort: unknown } | null;
      effort = raw ? raw.effort : previous?.effort;
    }
  } else {
    row = db.query(`SELECT source,account_key identity,model,speed,NULL service_tier,billing_mode billing,
      ts,q_out output,resp_ms,usage_valid valid FROM usage_ledger_facts
      WHERE provider=? AND row_id=? AND accounting=1 AND copy_state='canonical'`).get(provider, id) as typeof row;
    if (!row) return null;
    const adapter = subscriptionAccountingAdapters().find(a => a.id === provider);
    if (adapter && rawColumns(adapter.table).has("effort")) {
      const raw = db.query(`SELECT effort FROM ${adapter.table} WHERE id=?`).get(id) as { effort: unknown } | null;
      effort = raw ? raw.effort : previous?.effort;
    }
  }
  const ms = Date.parse(row.ts);
  if (!Number.isFinite(ms)) return null;
  const timed = row.valid && Number.isSafeInteger(row.resp_ms) && row.resp_ms > 0;
  const long = timed && row.output >= LONG_CALL_OUT;
  const dims = { source: row.source, identity: row.identity, model: row.model, speed: row.speed,
    effort: recordedEffort(effort), service_tier: row.service_tier, billing: row.billing };
  return { provider, event_id: id, key: JSON.stringify(dimensions.map(c => dims[c] ?? null)), ...dims,
    ts: new Date(ms).toISOString(), hour: Math.floor(ms / 3_600_000), calls: 1,
    timed_calls: timed ? 1 : 0, timed_out: timed ? row.output : 0, timed_ms: timed ? row.resp_ms : 0,
    timed_long_calls: long ? 1 : 0, timed_long_out: long ? row.output : 0, timed_long_ms: long ? row.resp_ms : 0 };
}

function contribute(db: Database, fact: ModelSpeedFact | null, sign: number): void {
  if (!fact) return;
  const cols = ["provider", "key", ...dimensions, "hour", ...measures] as const;
  db.query(`INSERT INTO model_speed_hours(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
    ON CONFLICT(provider,key,hour) DO UPDATE SET ${measures.map(c => `${c}=${c}+excluded.${c}`).join(",")}`)
    .run(...cols.map(c => measures.includes(c as typeof measures[number]) ? Number(fact[c]) * sign : fact[c]));
  db.query("DELETE FROM model_speed_hours WHERE provider=? AND key=? AND hour=? AND calls=0").run(fact.provider, fact.key, fact.hour);
}

/** Bounded, resumable projection; only the background database writer enters here. */
export function advanceModelSpeeds(db: Database, options: { canWrite?(): boolean; budgetMs?: number; limit?: number } = {}) {
  if (!hasModelSpeedSchema(db) || options.canWrite?.() === false) return { processed: 0, pending: false };
  installModelSpeedTracking(db);
  const start = performance.now();
  const schema = new Map<string, Set<string>>();
  const rawColumns = (table: string) => {
    let columns = schema.get(table);
    if (!columns) schema.set(table, columns = columnsOf(db, table));
    return columns;
  };
  const queue = modelSpeedQueueBatch(db, options.limit ?? 2000);
  let processed = 0;
  db.transaction(() => {
    const changed = new Set<string>();
    const serviced = new Map<string, number>();
    for (const q of queue) {
      if (options.canWrite?.() === false || performance.now() - start >= (options.budgetMs ?? 100)) break;
      const old = db.query("SELECT * FROM model_speed_facts WHERE provider=? AND event_id=?").get(q.provider, q.event_id) as ModelSpeedFact | null;
      const next = project(db, q.provider, q.event_id, old, rawColumns);
      if (JSON.stringify(old && factColumns.map(c => old[c])) !== JSON.stringify(next && factColumns.map(c => next[c]))) {
        contribute(db, old, -1); contribute(db, next, 1);
        db.query("DELETE FROM model_speed_facts WHERE provider=? AND event_id=?").run(q.provider, q.event_id);
        if (next) db.query(`INSERT INTO model_speed_facts(${factColumns.join(",")}) VALUES (${factColumns.map(() => "?").join(",")})`).run(...factColumns.map(c => next[c]));
        changed.add(q.provider);
      }
      db.query("DELETE FROM model_speed_queue WHERE provider=? AND event_id=?").run(q.provider, q.event_id);
      processed++;
      serviced.set(q.provider, (serviced.get(q.provider) ?? 0) + 1);
    }
    recordModelSpeedService(db, serviced);
    for (const provider of changed) db.query("UPDATE model_speed_state SET revision=revision+1 WHERE provider=?").run(provider);
    if (changed.size && db.query("SELECT 1 FROM sqlite_master WHERE name='analysis_source_revisions'").get())
      db.query(`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('model_speed_hours','*',1)
        ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1`).run();
  }).immediate();
  const remaining = modelSpeedQueueRemaining(db);
  return { processed, pending: remaining > 0, remaining };
}
