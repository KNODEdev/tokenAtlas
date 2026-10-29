import type { Database } from "./sqlite";
import { subscriptionAccountingAdapters } from "../server/subscription-accounting-adapters";

export const MODEL_TIMELINE_SCHEMA = `
CREATE TABLE model_timeline_state(provider TEXT PRIMARY KEY,bookmark INTEGER,scanning INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE model_timeline_dirty(provider TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(provider,day));
CREATE TABLE model_timeline_days(provider TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,first_ts TEXT NOT NULL,
  PRIMARY KEY(provider,day,model));
CREATE INDEX model_timeline_minimum ON model_timeline_days(provider,model,first_ts);
CREATE TABLE model_timeline_first(provider TEXT NOT NULL,model TEXT NOT NULL,first_ts TEXT NOT NULL,PRIMARY KEY(provider,model));
`;

const exists = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export const hasModelTimeline = (db: Database) => exists(db, "model_timeline_state");
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const providers = () => [{ id: "codex", table: "events" }, ...subscriptionAccountingAdapters().map(a => ({ id: a.id, table: a.table }))];
const rawFilter = (id: string) => id === "glm" ? " AND lower(provider) IN ('zai-coding-plan','zhipuai-coding-plan','zai','zhipuai','z-ai')" : "";

function triggerSql(id: string, table: string, op: string): string {
  const watched = ["ts", "model", ...(id === "glm" ? ["provider"] : [])];
  const enqueue = (side: string) => `INSERT INTO model_timeline_dirty(provider,day)
    VALUES('${id}',COALESCE(substr(${side}.ts,1,10),'')) ON CONFLICT(provider,day) DO NOTHING;`;
  return `CREATE TRIGGER model_timeline_${id}_${op} AFTER ${op.toUpperCase()} ON ${table}
    ${op === "update" ? `WHEN (${watched.map(c => `OLD.${c}`).join(",")}) IS NOT (${watched.map(c => `NEW.${c}`).join(",")})` : ""}
    BEGIN ${op !== "insert" ? enqueue("OLD") : ""}${op !== "delete" ? enqueue("NEW") : ""} END`;
}

export function isModelTimelineTrigger(name: string, table: string, sql: string): boolean {
  return providers().some(p => p.table === table && ["insert", "update", "delete"].some(op =>
    name === `model_timeline_${p.id}_${op}` && normalize(sql) === normalize(triggerSql(p.id, table, op))));
}

export function recordModelTimelineChanges(db: Database, table: string): void {
  for (const p of providers()) if (p.table === table) db.query(`INSERT INTO model_timeline_dirty(provider,day)
    SELECT ?,COALESCE(substr(ts,1,10),'') FROM ${table} WHERE 1${rawFilter(p.id)} GROUP BY 2
    ON CONFLICT(provider,day) DO NOTHING`).run(p.id);
}

/** Track only changes to the source evidence a marker actually uses, independently of timing and prices. */
function installTracking(db: Database, id: string, table: string): void {
  const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
  if (!columns.has("ts") || !columns.has("model")) return;
  db.transaction(() => {
    for (const op of ["insert", "update", "delete"]) {
      const name = `model_timeline_${id}_${op}`;
      const sql = triggerSql(id, table, op);
      const old = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | null;
      if (old && normalize(old.sql) === normalize(sql)) continue;
      db.exec(`DROP TRIGGER IF EXISTS ${name}`); db.exec(sql);
    }
    db.query("INSERT INTO model_timeline_state(provider) VALUES(?) ON CONFLICT(provider) DO NOTHING").run(id);
  }).immediate();
}

function publishModels(db: Database, provider: string, models: ReadonlySet<string>): boolean {
  let changed = false;
  for (const model of models) {
    const first = db.query("SELECT first_ts FROM model_timeline_days WHERE provider=? AND model=? ORDER BY first_ts LIMIT 1")
      .get(provider, model) as { first_ts: string } | null;
    if (!first) changed = !!db.query("DELETE FROM model_timeline_first WHERE provider=? AND model=?").run(provider, model).changes || changed;
    else changed = !!db.query(`INSERT INTO model_timeline_first VALUES(?,?,?) ON CONFLICT(provider,model)
      DO UPDATE SET first_ts=excluded.first_ts WHERE first_ts IS NOT excluded.first_ts`).run(provider, model, first.first_ts).changes || changed;
  }
  return changed;
}

/** Initial rows resume by source rowid; later work replaces only the affected source day's minima. */
export function advanceModelTimelines(db: Database, options: { budgetMs?: number; limit?: number; canWrite?(): boolean } = {}) {
  if (!hasModelTimeline(db) || options.canWrite?.() === false) return { processed: 0, pending: false };
  const deadline = performance.now() + (options.budgetMs ?? 100);
  let processed = 0, pending = false;
  const states = new Map((db.query("SELECT provider,bookmark,initialized FROM model_timeline_state").all() as
    { provider: string; bookmark: number | null; initialized: number }[]).map(row => [row.provider, row]));
  // Current corrections precede preparation; durable bookmarks interleave initial source scans across turns.
  const sources = providers().sort((a, b) => (states.get(b.id)?.initialized ?? 0) - (states.get(a.id)?.initialized ?? 0)
    || (states.get(a.id)?.bookmark ?? 0) - (states.get(b.id)?.bookmark ?? 0) || a.id.localeCompare(b.id));
  const limit = options.limit ?? 20000;
  for (const { id, table } of sources) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !/^[a-z][a-z0-9_]*$/.test(table)) throw new Error("Invalid timeline provider");
    if (!exists(db, table) || options.canWrite?.() === false) continue;
    installTracking(db, id, table);
    const state = db.query("SELECT * FROM model_timeline_state WHERE provider=?").get(id) as
      { bookmark: number | null; scanning: number; initialized: number } | null;
    if (!state) continue;
    const dirty = db.query("SELECT day FROM model_timeline_dirty WHERE provider=? ORDER BY day DESC LIMIT 1").get(id) as { day: string } | null;
    if (performance.now() >= deadline && processed) { pending ||= !!state.scanning || !!dirty; continue; }
    if (!state.scanning && !dirty) continue;
    db.transaction(() => {
      const models = new Set<string>();
      if (state.scanning) {
        const rows = db.query(`SELECT rowid id,model,ts FROM ${table} WHERE model IS NOT NULL AND model<>'' AND ts IS NOT NULL
          ${state.bookmark === null ? "" : "AND rowid>?"}${rawFilter(id)} ORDER BY rowid LIMIT ?`)
          .all(...(state.bookmark === null ? [limit] : [state.bookmark, limit])) as { id: number; model: string; ts: string }[];
        let bookmark = state.bookmark;
        const minima = new Map<string, { day: string; model: string; ts: string }>();
        for (const row of rows) {
          if (options.canWrite?.() === false || processed && performance.now() >= deadline) break;
          const day = row.ts.slice(0, 10), key = JSON.stringify([day, row.model]), previous = minima.get(key);
          if (!previous || row.ts < previous.ts) minima.set(key, { day, model: row.model, ts: row.ts });
          models.add(row.model); bookmark = row.id; processed++;
        }
        for (const row of minima.values()) db.query(`INSERT INTO model_timeline_days VALUES(?,?,?,?) ON CONFLICT(provider,day,model)
          DO UPDATE SET first_ts=MIN(first_ts,excluded.first_ts) WHERE excluded.first_ts<first_ts`).run(id, row.day, row.model, row.ts);
        const scanning = rows.length === limit || rows.some(row => bookmark === null || row.id > bookmark);
        db.query("UPDATE model_timeline_state SET bookmark=?,scanning=? WHERE provider=?").run(bookmark, Number(scanning), id);
      } else if (dirty) {
        for (const row of db.query("SELECT model FROM model_timeline_days WHERE provider=? AND day=?").all(id, dirty.day) as { model: string }[]) models.add(row.model);
        db.query("DELETE FROM model_timeline_days WHERE provider=? AND day=?").run(id, dirty.day);
        const rows = db.query(`SELECT model,MIN(ts) first_ts FROM ${table} WHERE model IS NOT NULL AND model<>''
          AND ${dirty.day ? "ts>=?1 AND ts<?1||'~' AND substr(ts,1,10)=?1" : "(ts IS NULL OR ts='')"}${rawFilter(id)}
          GROUP BY model HAVING MIN(ts) IS NOT NULL`).all(...(dirty.day ? [dirty.day] : [])) as { model: string; first_ts: string }[];
        for (const row of rows) {
          db.query("INSERT INTO model_timeline_days VALUES(?,?,?,?)").run(id, dirty.day, row.model, row.first_ts); models.add(row.model);
        }
        db.query("DELETE FROM model_timeline_dirty WHERE provider=? AND day=?").run(id, dirty.day); processed++;
      }
      const changed = publishModels(db, id, models);
      const remaining = !!db.query(`SELECT 1 FROM model_timeline_state WHERE provider=? AND scanning=1
        UNION ALL SELECT 1 FROM model_timeline_dirty WHERE provider=? LIMIT 1`).get(id, id);
      if (changed || !state.initialized && !remaining) {
        db.query("UPDATE model_timeline_state SET revision=revision+1,initialized=MAX(initialized,?) WHERE provider=?").run(Number(!remaining), id);
        if (exists(db, "analysis_source_revisions")) db.query(`INSERT INTO analysis_source_revisions VALUES('model_timeline_first','*',1)
          ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1`).run();
      }
      pending ||= remaining;
    }).immediate();
  }
  return { processed, pending };
}

export function readModelTimeline(db: Database, provider: string): { ready: boolean; pending: boolean; models: { model: string; first_ts: string }[] } {
  const source = providers().find(row => row.id === provider);
  if (source && !exists(db, source.table)) return { ready: true, pending: false, models: [] };
  if (!hasModelTimeline(db)) return { ready: false, pending: true, models: [] };
  const state = db.query("SELECT initialized,scanning FROM model_timeline_state WHERE provider=?").get(provider) as { initialized: number; scanning: number } | null;
  if (!state?.initialized) return { ready: false, pending: true, models: [] };
  return { ready: true, pending: !!state.scanning || !!db.query("SELECT 1 FROM model_timeline_dirty WHERE provider=? LIMIT 1").get(provider),
    models: db.query("SELECT model,first_ts FROM model_timeline_first WHERE provider=? ORDER BY first_ts,model").all(provider) as { model: string; first_ts: string }[] };
}
