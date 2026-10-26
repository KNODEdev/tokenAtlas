import type { Database } from "../db/sqlite";
import { ARCHIVE_LOGICAL_ROOT, toArchivePhysicalPath } from "../config/paths";
import { archiveRepresentations } from "../ingest/archive-codec";
import { ParsePool } from "../ingest/parse-pool";
import { fileStamp } from "../sync/jsonl-inspection";
import { archiveSourceKey } from "./event-source";
import { firstTokenAdapters } from "../providers/first-token";
import type { FirstTokenAdapter, FirstTokenTurn } from "../providers/first-token/types";
import { hasFirstTokenSchema, installFirstTokenTracking, replaceFirstTokenFile } from "../db/first-token";

type Prepared = { turns: FirstTokenTurn[] } | { error: Error };
export interface FirstTokenReader {
  accepts?(key: string): boolean;
  read(key: string, generation: string, adapter: FirstTokenAdapter, file: string): Prepared | null;
  forget(key: string): void;
  retain?(keys: Set<string>): void;
}
const witness = (file: string): string => JSON.stringify(archiveRepresentations(file).map(path => [path, fileStamp(path)]));

/** Parsing never waits inside a writer turn. Ready results survive a temporarily unavailable lease. */
export class NativeFirstTokenReader implements FirstTokenReader {
  private pool?: ParsePool;
  private closed = false;
  private jobs = new Map<string, { generation: string; result?: Prepared }>();
  constructor(private readonly onReady: () => void, private readonly capacity = 32,
    private readonly createPool = () => new ParsePool(2)) {}
  accepts(key: string): boolean { return !this.closed && (this.jobs.has(key) || this.jobs.size < this.capacity); }
  read(key: string, generation: string, adapter: FirstTokenAdapter, file: string): Prepared | null {
    const known = this.jobs.get(key);
    if (known?.generation === generation) return known.result ?? null;
    if (known && !known.result) return null;
    this.jobs.delete(key);
    if (this.closed || this.jobs.size >= this.capacity) return null;
    const job: { generation: string; result?: Prepared } = { generation };
    this.jobs.set(key, job);
    // Defer native submission until the synchronous writer turn has returned its lease.
    void Promise.resolve().then(async () => {
      if (this.closed) throw new Error("First-token reader closed before submission");
      const before = witness(file);
      if (!adapter.prepare) throw new Error(`No native first-token adapter: ${adapter.id}`);
      const turns = await adapter.prepare(this.pool ??= this.createPool(), file);
      if (witness(file) !== before) throw new Error(`Archive source changed while reading: ${file}`);
      return { turns } satisfies Prepared;
    }).then(result => { job.result = result; }, error => { job.result = { error: error instanceof Error ? error : new Error(String(error)) }; })
      .finally(() => { if (!this.closed) this.onReady(); });
    return null;
  }
  forget(key: string): void { this.jobs.delete(key); }
  retain(keys: Set<string>): void { for (const [key, job] of this.jobs) if (job.result && !keys.has(key)) this.jobs.delete(key); }
  async close(): Promise<void> { this.closed = true; await this.pool?.close(); this.jobs.clear(); }
}

/** Shared, bounded background job. GET readers never enter this module. */
export function advanceFirstTokenTimes(db: Database, options: { adapters?: readonly FirstTokenAdapter[]; canWrite?(): boolean;
  archiveRoot?: string; physicalPath?: (path: string) => string; now?: number; budgetMs?: number; limit?: number;
  clock?(): number; reader?: FirstTokenReader } = {}) {
  if (!hasFirstTokenSchema(db)) return { processed: 0, pending: false, failed: 0, remaining: 0, completed: 0, total: 0 };
  const adapters = (options.adapters ?? firstTokenAdapters).filter(adapter =>
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(adapter.files.table)), now = options.now ?? Date.now();
  const clock = options.clock ?? (() => performance.now()), started = clock();
  if (options.canWrite?.() !== false) for (const adapter of adapters) installFirstTokenTracking(db, adapter);
  const queue = db.query("SELECT provider,owner,path,priority FROM response_time_queue WHERE retry_at<=? ORDER BY retry_at,priority DESC LIMIT ?")
    .all(now, Math.max(1, options.limit ?? 128)) as { provider: string; owner: string; path: string; priority: number }[];
  options.reader?.retain?.(new Set(queue.map(q => JSON.stringify([q.provider, q.owner, q.path]))));
  let processed = 0;
  const preparedColumns = new Map(adapters.flatMap(adapter => adapter.prepared ? [[adapter.id,
    new Set((db.query(`PRAGMA table_info(${adapter.prepared.table})`).all() as { name: string }[]).map(c => c.name))] as const] : []));
  for (const queued of queue) {
    if (options.canWrite?.() === false || clock() - started >= (options.budgetMs ?? 250)) break;
    const adapter = adapters.find(a => a.id === queued.provider);
    if (adapter) try {
      const source = archiveSourceKey(queued.path, options.archiveRoot ?? ARCHIVE_LOGICAL_ROOT);
      const { table, owner } = adapter.files;
      const exists = db.query(`SELECT size,mtime FROM ${table} WHERE ${owner}=? AND path=?`).get(queued.owner, queued.path) as { size: number; mtime: number } | null;
      let turns: ReturnType<FirstTokenAdapter["parse"]> = [];
      const key = JSON.stringify([queued.provider, queued.owner, queued.path]);
      if (source && exists) {
        const cached = adapter.prepared;
        const row = cached && preparedColumns.get(adapter.id)?.has(cached.column)
          ? db.query(`SELECT ${cached.column} payload FROM ${cached.table} WHERE ${cached.owner}=? AND path=?`).get(queued.owner, queued.path) as { payload: string | null } | null : null;
        const payload = row?.payload ? JSON.parse(row.payload) as { version: number; turns: FirstTokenTurn[]; bookmark?: { size: number; mtime: number } } : null;
        if (payload?.version === adapter.version && Array.isArray(payload.turns)
          && payload.bookmark?.size === exists.size && payload.bookmark.mtime === exists.mtime) turns = payload.turns;
        else {
          if (!options.reader) throw new Error("Native first-token reader is unavailable");
          if (options.reader.accepts?.(key) === false) continue;
          const file = (options.physicalPath ?? toArchivePhysicalPath)(queued.path);
          const generation = JSON.stringify([adapter.version, exists.size, exists.mtime, queued.priority, witness(file)]);
          const ready = options.reader.read(key, generation, adapter, file);
          if (!ready) continue;
          if ("error" in ready) { options.reader.forget(key); throw ready.error; }
          turns = ready.turns;
        }
      }
      if (options.canWrite?.() !== false) {
        replaceFirstTokenFile(db, queued.provider, queued.owner, queued.path, source, turns);
        options.reader?.forget(key);
        processed++;
      }
    } catch (error) {
      if (options.canWrite?.() !== false) db.query("UPDATE response_time_queue SET retry_at=?,error=? WHERE provider=? AND owner=? AND path=?")
        .run(now + 60_000, error instanceof Error ? error.message : String(error), queued.provider, queued.owner, queued.path);
    }
  }
  const status = db.query("SELECT COUNT(*) pending,SUM(error IS NOT NULL) failed FROM response_time_queue").get() as { pending: number; failed: number | null };
  // Bookmarks minus the durable queue include already checked files with no measured turns.
  let completed = 0;
  for (const adapter of adapters) {
    const { table, owner } = adapter.files;
    completed += (db.query(`SELECT COUNT(*) n FROM ${table} f WHERE NOT EXISTS
      (SELECT 1 FROM response_time_queue q WHERE q.provider=? AND q.owner=f.${owner} AND q.path=f.path)`)
      .get(adapter.id) as { n: number }).n;
  }
  return { processed, pending: status.pending > 0, failed: status.failed ?? 0, remaining: status.pending,
    completed, total: completed + status.pending };
}
