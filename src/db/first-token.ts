import type { Database } from "./sqlite";
import type { FirstTokenAdapter, FirstTokenTurn } from "../providers/first-token/types";

export const hasFirstTokenSchema = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='response_time_state'").get();
export function installFirstTokenTracking(db: Database, adapter: FirstTokenAdapter): void {
  const { id, version, files: { table, owner } } = adapter;
  for (const name of [id, table, owner]) if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("Invalid timing adapter identifier");
  const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  if (![owner, "path", "size", "mtime"].every(c => columns.has(c))) return;
  const state = db.query("SELECT version FROM response_time_state WHERE provider=?").get(id) as { version: number } | null;
  const tracking = db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN (?,?,?)")
    .get(...["insert", "update", "delete"].map(op => `first_token_${id}_${op}`)) as { n: number };
  if (state?.version === version && tracking.n === 3) return;
  db.transaction(() => {
    const enqueue = (side: string) => `INSERT INTO response_time_queue(provider,owner,path,priority) VALUES ('${id}',${side}.${owner},${side}.path,COALESCE(${side}.mtime,0))
      ON CONFLICT(provider,owner,path) DO UPDATE SET retry_at=0,error=NULL,priority=excluded.priority;`;
    for (const op of ["insert", "update", "delete"]) {
      const name = `first_token_${id}_${op}`;
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER ${name} AFTER ${op.toUpperCase()} ON ${table}
        ${op === "update" ? `WHEN OLD.size IS NOT NEW.size OR OLD.mtime IS NOT NEW.mtime OR OLD.path IS NOT NEW.path OR OLD.${owner} IS NOT NEW.${owner}` : ""}
        BEGIN ${op !== "insert" ? enqueue("OLD") : ""} ${op !== "delete" ? enqueue("NEW") : ""} END`);
    }
    db.query(`INSERT OR IGNORE INTO response_time_queue(provider,owner,path,priority) SELECT ?,${owner},path,COALESCE(mtime,0) FROM ${table}`).run(id);
    db.query(`INSERT OR IGNORE INTO response_time_queue(provider,owner,path) SELECT provider,owner,path FROM response_time_copies WHERE provider=?`).run(id);
    db.query(`INSERT INTO response_time_state(provider,version) VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET version=excluded.version`).run(id, version);
  }).immediate();
}

interface StoredTurn { provider: string; turn_id: string; source: string | null; model: string | null; ts: string; ms: number | null; billing: string; reason: string | null }
function contribution(db: Database, row: StoredTurn | null, sign: number): void {
  if (!row?.source || !row.model) return;
  const args = [row.provider, row.source, row.model, row.billing, Math.floor(Date.parse(row.ts) / 3_600_000), row.ms ?? -1] as const;
  db.query(`INSERT INTO response_time_hours(provider,source,model,billing,hour,ms,turns) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(provider,source,hour,model,billing,ms) DO UPDATE SET turns=turns+excluded.turns`).run(...args, sign);
  db.query("DELETE FROM response_time_hours WHERE provider=? AND source=? AND model=? AND billing=? AND hour=? AND ms=? AND turns=0").run(...args);
}

/** One file publication: copies, canonical turns and histogram contributions commit together. */
export function replaceFirstTokenFile(db: Database, provider: string, owner: string, path: string, source: string | null,
  turns: readonly FirstTokenTurn[]): boolean {
  return db.transaction(() => {
    const old = db.query("SELECT turn_id,source,model,ts,ms,billing,reason FROM response_time_copies WHERE provider=? AND owner=? AND path=? ORDER BY turn_id")
      .all(provider, owner, path) as Omit<StoredTurn, "provider">[];
    const next = source ? turns.map(t => ({ turn_id: t.id, source, model: t.model, ts: t.ts, ms: t.ms, billing: t.billing, reason: t.reason }))
      .sort((a, b) => a.turn_id.localeCompare(b.turn_id)) : [];
    if (JSON.stringify(old) === JSON.stringify(next)) {
      db.query("DELETE FROM response_time_queue WHERE provider=? AND owner=? AND path=?").run(provider, owner, path);
      return false;
    }
    const ids = new Set([...old, ...next].map(t => t.turn_id));
    db.query("DELETE FROM response_time_copies WHERE provider=? AND owner=? AND path=?").run(provider, owner, path);
    const insert = db.query("INSERT INTO response_time_copies VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const row of next) insert.run(provider, owner, path, row.turn_id, row.source, row.model, row.ts, row.ms, row.billing, row.reason);
    for (const id of ids) {
      const previous = db.query("SELECT * FROM response_time_turns WHERE provider=? AND turn_id=?").get(provider, id) as StoredTurn | null;
      // Ordering must not make SQLite scan every turn of a provider to find one identity.
      const copies = db.query("SELECT provider,turn_id,source,model,ts,ms,billing,reason FROM response_time_copies INDEXED BY response_time_copies_turn WHERE provider=? AND turn_id=? ORDER BY owner,path")
        .all(provider, id) as StoredTurn[];
      let canonical: StoredTurn | null = copies[0] ? { ...copies[0] } : null;
      if (canonical) {
        const dimensions = new Set(copies.map(t => JSON.stringify([t.source, t.model, t.ts, t.billing])));
        const measured = new Set(copies.flatMap(t => t.ms === null ? [] : [t.ms]));
        if (dimensions.size > 1) canonical = { ...canonical, source: null, model: null, ms: null, reason: "conflicting_identity" };
        else if (measured.size > 1 || copies.some(t => t.reason?.startsWith("conflicting"))) canonical = { ...canonical, ms: null, reason: "conflicting_measurement" };
        else if (measured.size === 1) canonical = { ...canonical, ms: [...measured][0]!, reason: null };
      }
      if (JSON.stringify(previous) === JSON.stringify(canonical)) continue;
      contribution(db, previous, -1);
      db.query("DELETE FROM response_time_turns WHERE provider=? AND turn_id=?").run(provider, id);
      if (canonical) {
        const t = canonical;
        db.query("INSERT INTO response_time_turns VALUES (?,?,?,?,?,?,?,?)").run(t.provider, t.turn_id, t.source, t.model, t.ts, t.ms, t.billing, t.reason);
        contribution(db, canonical, 1);
      }
    }
    db.query("UPDATE response_time_state SET revision=revision+1 WHERE provider=?").run(provider);
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_source_revisions'").get())
      db.query(`INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('response_time_hours','*',1)
        ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1`).run();
    db.query("DELETE FROM response_time_queue WHERE provider=? AND owner=? AND path=?").run(provider, owner, path);
    return true;
  }).immediate();
}
