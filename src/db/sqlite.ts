import { Database as BunDatabase, type Statement, type SQLQueryBindings } from "bun:sqlite";
import { isMainThread, threadId } from "node:worker_threads";

export type { SQLQueryBindings, Statement } from "bun:sqlite";
export type Database = BunDatabase;
const readonlyConnections = new WeakSet<BunDatabase>();
/** Only handles opened readonly by this wrapper can safely retain read results across caller transactions. */
export const isReadonlyConnection = (db: BunDatabase): boolean => readonlyConnections.has(db);

// Bun exposes this handle via Statement.native, but leaves its type unspecified.
type NativeStatement = { finalize(): void };

const prepared = new WeakMap<BunDatabase, Map<string, Statement>>();
/**
 * One statement per connection and SQL text, for queries issued per row. Bun caches only the
 * first 20 distinct queries of a connection; any later one is prepared again on every call, and
 * inside one synchronous job none of those statements can be collected. The connection owns
 * and finalizes them on close.
 */
export function preparedStatement(db: BunDatabase, sql: string): Statement {
  let cache = prepared.get(db);
  if (!cache) { cache = new Map(); prepared.set(db, cache); }
  let statement = cache.get(sql);
  if (!statement) { statement = db.prepare(sql); cache.set(sql, statement); }
  return statement;
}

const QUERY_CACHE_LIMIT = 1024;

/**
 * How long any connection waits for another's write lock (U2.2), the same for all of them. Long
 * write work is coordinated by the write lease (write-lease.ts), so a wait is only ever for a
 * single row or one bounded batch of the lease holder.
 */
export const BUSY_TIMEOUT_MS = 5_000;
const SQLITE_OPEN_READONLY = 0x1;

/**
 * A transaction held this long stalls every other writer, and HTTP reads that queue data
 * preparation do not wait for the lock, so the screen answers 503 until it ends. Batches aim
 * well below it (BATCH_MS); anything at or over one second is reported, so an overlong batch is
 * seen long before it reaches the busy timeout of a waiting writer.
 */
const LONG_TRANSACTION_MS = 1_000;

interface OpenTransaction { startedAt: number; changes: number }

let transactionContext = "";
/**
 * Names the job this thread runs in long-transaction warnings, since a report builder's stack
 * does not say which report it builds. A worker sets it per job and clears it afterwards.
 */
export function setTransactionContext(label: string): void { transactionContext = label; }

function totalChanges(db: BunDatabase): number {
  return (preparedStatement(db, "SELECT total_changes() AS n").get() as { n: number }).n;
}

/**
 * Only a transaction that changed rows holds the write lock; a long read pins the WAL instead.
 * Rows changed in TEMP tables count in `total_changes()` but take no lock on the database, so a
 * read-only connection (a report worker) is always reported as a read.
 */
function reportLongTransaction(db: BunDatabase, open: OpenTransaction, readOnly: boolean): void {
  const ms = performance.now() - open.startedAt;
  if (ms < LONG_TRANSACTION_MS) return;
  const kind = readOnly || totalChanges(db) === open.changes ? "read" : "write";
  const site = (new Error().stack ?? "").split("\n").slice(1).map(line => line.trim())
    .filter(line => line.startsWith("at ") && !/[\\/]db[\\/]sqlite\.ts|bun:sqlite/.test(line)).slice(0, 6).join(" <- ");
  const context = transactionContext ? ` (${transactionContext})` : "";
  console.warn(`[tokenAtlas sqlite] ${kind} transaction held ${(ms / 1000).toFixed(1)} s on ${isMainThread ? "main" : `worker ${threadId}`}${context}: ${site}`);
}

/** Connections own all their statements, including queries beyond Bun's cache. */
export const Database: typeof BunDatabase = class extends BunDatabase {
  private readonly statements = new Map<WeakRef<Statement>, NativeStatement>();
  private readonly collected = new FinalizationRegistry<WeakRef<Statement>>(reference => {
    this.statements.get(reference)?.finalize();
    this.statements.delete(reference);
  });
  private preparations = 0;
  // Bun's query() cache stops at 20 distinct statements; every later query is prepared again on
  // each call, and within one synchronous job none of those statements can be collected, so a
  // per-row query grew the process by gigabytes. Least recently used entries leave the cache
  // unfinalized: a caller may still hold them, and collection then releases them as before.
  private readonly queryCache = new Map<string, Statement>();
  private readonly wrappedIterators = new WeakSet<Statement>();
  private readonly finalizedStatements = new WeakSet<Statement>();
  private transactionDepth = 0;
  private manualTransaction: OpenTransaction | null = null;
  private readonly readOnly: boolean;

  constructor(...args: ConstructorParameters<typeof BunDatabase>) {
    super(...args);
    const options = args[1];
    this.readOnly = typeof options === "number" ? (options & SQLITE_OPEN_READONLY) !== 0
      : typeof options === "object" && options !== null && options.readonly === true;
    if (this.readOnly) readonlyConnections.add(this);
    this.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  }

  override transaction<A extends unknown[], T>(insideTransaction: (...args: A) => T) {
    const connection = this;
    return super.transaction(function (this: unknown, ...args: A): T {
      // Nested calls are savepoints inside the outer transaction, which is the one holding the lock.
      const open = connection.transactionDepth++ === 0 ? { startedAt: performance.now(), changes: totalChanges(connection) } : null;
      try { return insideTransaction.apply(this, args); }
      finally {
        connection.transactionDepth--;
        if (open) reportLongTransaction(connection, open, connection.readOnly);
      }
    });
  }

  // Bun aliases exec to run; both carry hand-written BEGIN ... COMMIT blocks.
  override run(...args: Parameters<BunDatabase["run"]>): ReturnType<BunDatabase["run"]> {
    const result = Reflect.apply(BunDatabase.prototype.run, this, args) as ReturnType<BunDatabase["run"]>;
    const sql = args[0];
    if (typeof sql === "string") {
      if (/^\s*BEGIN\b/i.test(sql)) this.manualTransaction ??= { startedAt: performance.now(), changes: totalChanges(this) };
      else if (this.manualTransaction && /^\s*(?:COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)) {
        const open = this.manualTransaction;
        this.manualTransaction = null;
        reportLongTransaction(this, open, this.readOnly);
      }
    }
    return result;
  }

  override exec(...args: Parameters<BunDatabase["exec"]>): ReturnType<BunDatabase["exec"]> {
    return this.run(...args);
  }

  override query<Row, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string,
  ): ReturnType<typeof BunDatabase.prototype.query<Row, ParamsType>> {
    type Result = ReturnType<typeof BunDatabase.prototype.query<Row, ParamsType>>;
    const cached = this.queryCache.get(sql);
    if (cached) {
      this.queryCache.delete(sql);
      this.queryCache.set(sql, cached);
      return cached as unknown as Result;
    }
    // Bun's second cache could return an iterating or explicitly finalized statement.
    const statement = this.prepare<Row, ParamsType>(sql);
    // A lazy iteration owns its statement: a nested call with the same SQL would reset it.
    // Bun can return the same statement after that eviction; wrapping it again chains closures.
    if (!this.wrappedIterators.has(statement as Statement)) {
      const iterate = statement.iterate;
      const cache = this.queryCache;
      const finalized = this.finalizedStatements;
      statement.iterate = (...params: Parameters<typeof iterate>) => {
        if (cache.get(sql) === (statement as unknown as Statement)) cache.delete(sql);
        return (function* () {
          try { yield* iterate.apply(statement, params); }
          finally {
            if (!finalized.has(statement as unknown as Statement) && !cache.has(sql)) {
              cache.set(sql, statement as unknown as Statement);
              if (cache.size > QUERY_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            }
          }
        })();
      };
      this.wrappedIterators.add(statement as Statement);
    }
    this.queryCache.set(sql, statement as unknown as Statement);
    if (this.queryCache.size > QUERY_CACHE_LIMIT) this.queryCache.delete(this.queryCache.keys().next().value!);
    return statement;
  }

  override prepare<Row, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string, params?: ParamsType, flags = 0,
  ): ReturnType<typeof BunDatabase.prototype.prepare<Row, ParamsType>> {
    // Sweep even if registry callbacks have not run. Never evict a live caller's
    // statement: connection-level caches and iterators may still depend on it.
    // The interval grows with the tracked set, so a sweep costs amortized O(1) per
    // preparation; a fixed interval made per-row query churn quadratic.
    if (++this.preparations >= Math.max(64, this.statements.size)) {
      this.preparations = 0;
      for (const [reference, native] of this.statements) {
        if (reference.deref()) continue;
        native.finalize();
        this.statements.delete(reference);
        this.collected.unregister(reference);
      }
    }
    // query() supplies an internal preparation flag absent from Bun's public types.
    const statement = Reflect.apply(BunDatabase.prototype.prepare, this, [sql, params, flags]) as
      ReturnType<typeof BunDatabase.prototype.prepare<Row, ParamsType>>;
    const reference = new WeakRef(statement as Statement);
    // The JS wrapper can die before Bun destroys its native sqlite3_stmt.
    // Retain only the native handle until explicit finalization or wrapper GC.
    const native = statement.native as Partial<NativeStatement> | undefined;
    // Statement.native is untyped Bun API; without it strict close cannot be guaranteed.
    if (typeof native?.finalize !== "function") {
      statement.finalize();
      throw new Error("bun:sqlite Statement.native.finalize is unavailable in this Bun version");
    }
    this.statements.set(reference, native as NativeStatement);
    this.collected.register(statement, reference, reference);
    const finalize = statement.finalize;
    statement.finalize = () => {
      finalize.call(statement);
      this.finalizedStatements.add(statement as unknown as Statement);
      this.statements.delete(reference);
      this.collected.unregister(reference);
      if (this.queryCache.get(sql) === (statement as unknown as Statement)) this.queryCache.delete(sql);
    };
    return statement;
  }

  static override open(...args: Parameters<typeof BunDatabase.open>): BunDatabase {
    return new Database(...args);
  }

  static override deserialize(
    serialized: NodeJS.TypedArray | ArrayBufferLike,
    options: boolean | { readonly?: boolean; strict?: boolean; safeIntegers?: boolean } = false,
  ): BunDatabase {
    // Bun's deserialize delegates to its byte-buffer constructor, which is not typed.
    return Reflect.construct(Database, [serialized, typeof options === "boolean" ? { readonly: options } : options]) as BunDatabase;
  }

  override close(throwOnError = false): void {
    // Bun 1.3.14 closes only its cached statements (20 distinct queries).
    let failed = false;
    let failure: unknown;
    for (const [reference, native] of this.statements) {
      try {
        const statement = reference.deref();
        if (statement) statement.finalize();
        else native.finalize();
      }
      catch (error) { failed = true; failure ??= error; }
      this.collected.unregister(reference);
    }
    this.statements.clear();
    this.queryCache.clear();
    super.close(throwOnError);
    if (failed) throw failure;
  }
};
