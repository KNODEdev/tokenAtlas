import { randomUUID } from "node:crypto";
import type { Database } from "./sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * The one write lease of the database (U2.2): outside single-row writes, only its holder opens
 * multi-row write transactions. Holders are the background worker of the server, the sync process
 * while it publishes and refreshes derived tables, and the project remap. A party that wants the
 * lease while another holds it records a request; the holder hands over at its next batch boundary
 * (the background worker checks between batches; the sync process holds it only for publication
 * and the derived refresh, so the worker works during staging). A free lease with a fresh request
 * goes to the requester, so neither side can take it twice in a row while the other waits.
 *
 * A holder that checks `mayContinue` keeps the lease for at least one slice (`MIN_HOLD_MS`) even
 * when a request is waiting, so a handover always makes progress on both sides instead of the
 * lease bouncing back before its new holder did any work.
 *
 * A lease is stale, and may be taken, when its holder's process is gone, when the same kind of
 * holder in the same process restarted (a crashed worker thread), or when it was not renewed
 * within its time to live (a crash backstop; holders renew at their batch boundaries, and a
 * single synchronous step never runs anywhere near it).
 */
export type WriteLeaseKind = "background" | "sync" | "remap";
export interface WriteLeaseHolder { kind: WriteLeaseKind; owner: string; pid: number; expiresAt: number }

const SCHEMA = `CREATE TABLE IF NOT EXISTS write_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), kind TEXT, owner TEXT, pid INTEGER, expires_at INTEGER,
  requested_by TEXT, requested_kind TEXT, request_expires_at INTEGER) STRICT`;
/** A request lapses when its party stops asking (it asks again on every attempt). */
const REQUEST_TTL_MS = 5_000;
const TTL_MS: Record<WriteLeaseKind, number> = { background: 60_000, sync: 15 * 60_000, remap: 15 * 60_000 };
/** The least a holder keeps the lease against a waiting request (see the module comment). */
const MIN_HOLD_MS = 1_000;
const busy = (error: unknown) => /database is locked|SQLITE_BUSY/i.test(String(error));

interface Row { kind: WriteLeaseKind | null; owner: string | null; pid: number | null; expires_at: number | null;
  requested_by: string | null; requested_kind: string | null; request_expires_at: number | null }

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function ensureWriteLeaseSchema(db: Database): void {
  asSchemaWriter(db, () => {
    db.exec(SCHEMA);
    db.exec("INSERT OR IGNORE INTO write_lease(singleton) VALUES(1)");
  });
}

/** Who holds the lease now, or null; read without waiting, for gates and status. */
export function writeLeaseHolder(db: Database, now = Date.now()): WriteLeaseHolder | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='write_lease'").get()) return null;
  const row = db.query("SELECT * FROM write_lease WHERE singleton=1").get() as Row | null;
  if (!row?.owner || !row.kind || row.pid === null || row.expires_at === null) return null;
  if (row.expires_at < now || !processAlive(row.pid)) return null;
  return { kind: row.kind, owner: row.owner, pid: row.pid, expiresAt: row.expires_at };
}

export class WriteLease {
  readonly owner: string;
  private holding = false;
  private acquiredAt = 0;
  constructor(private readonly db: Database, readonly kind: WriteLeaseKind,
    private readonly now: () => number = Date.now) {
    this.owner = `${kind}:${process.pid}:${randomUUID()}`;
  }

  /** Whether this party holds the lease (as last written by it). */
  get held(): boolean { return this.holding; }

  /**
   * Takes the lease when it is free (or stale) and nobody else is waiting for it; otherwise asks
   * for it. A database busy past the shared busy timeout (a holder's long exception transaction)
   * is an ordinary "not now".
   */
  tryAcquire(): boolean {
    const now = this.now();
    const held = this.holding;
    try { this.holding = this.claim(now); }
    catch (error) { if (!busy(error)) throw error; this.holding = false; }
    if (this.holding && !held) this.acquiredAt = now;
    return this.holding;
  }

  private claim(now: number): boolean {
    return this.db.transaction(() => {
      ensureWriteLeaseSchema(this.db);
      const row = this.db.query("SELECT * FROM write_lease WHERE singleton=1").get() as Row;
      const mine = row.owner === this.owner;
      const stale = !row.owner || row.expires_at === null || row.expires_at < now || row.pid === null || !processAlive(row.pid)
        || (row.kind === this.kind && row.pid === process.pid);
      const othersWaiting = !!row.requested_by && row.requested_by !== this.owner && (row.request_expires_at ?? 0) >= now;
      if (mine || (stale && !othersWaiting)) {
        this.db.query(`UPDATE write_lease SET kind=?,owner=?,pid=?,expires_at=?,
            requested_by=CASE WHEN requested_by=? THEN NULL ELSE requested_by END,
            requested_kind=CASE WHEN requested_by=? THEN NULL ELSE requested_kind END,
            request_expires_at=CASE WHEN requested_by=? THEN NULL ELSE request_expires_at END WHERE singleton=1`)
          .run(this.kind, this.owner, process.pid, now + TTL_MS[this.kind], this.owner, this.owner, this.owner);
        return true;
      }
      // Ask for it; the first fresh request stands until its party stops asking.
      if (!othersWaiting) this.db.query("UPDATE write_lease SET requested_by=?,requested_kind=?,request_expires_at=? WHERE singleton=1")
        .run(this.owner, this.kind, now + REQUEST_TTL_MS);
      return false;
    }).immediate();
  }

  /** Waits for the lease, asking again every `pollMs`; true once held, false when `stop` says to give up. */
  async acquire(options: { pollMs?: number; stop?: () => boolean; wait?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (;;) {
      if (this.tryAcquire()) return true;
      if (options.stop?.()) return false;
      await wait(options.pollMs ?? 100);
    }
  }

  /**
   * Whether the holder may start its next batch: it still holds the lease and nobody asked for it.
   * Renews the lease while it does, so a holder that keeps checking never goes stale.
   */
  mayContinue(): boolean {
    if (!this.holding) return false;
    const now = this.now();
    const row = this.db.query("SELECT owner,expires_at,requested_by,request_expires_at FROM write_lease WHERE singleton=1").get() as
      Pick<Row, "owner" | "expires_at" | "requested_by" | "request_expires_at"> | null;
    if (row?.owner !== this.owner) { this.holding = false; return false; }
    if (row.requested_by && row.requested_by !== this.owner && (row.request_expires_at ?? 0) >= now
      && now - this.acquiredAt >= MIN_HOLD_MS) return false;
    // Renewed once half its time to live has passed, not on every batch.
    if ((row.expires_at ?? 0) - now < TTL_MS[this.kind] / 2)
      this.db.query("UPDATE write_lease SET expires_at=? WHERE singleton=1 AND owner=?").run(now + TTL_MS[this.kind], this.owner);
    return true;
  }

  /** Gives the lease back; a party that only asked withdraws its request. */
  release(): void {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='write_lease'").get()) { this.holding = false; return; }
    this.db.transaction(() => {
      this.db.query("UPDATE write_lease SET kind=NULL,owner=NULL,pid=NULL,expires_at=NULL WHERE singleton=1 AND owner=?").run(this.owner);
      this.db.query("UPDATE write_lease SET requested_by=NULL,requested_kind=NULL,request_expires_at=NULL WHERE singleton=1 AND requested_by=?").run(this.owner);
    }).immediate();
    this.holding = false;
  }
}
