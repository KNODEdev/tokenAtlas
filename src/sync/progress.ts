import fs from "node:fs";
import path from "node:path";
import { PROGRESS_UNITS, type ProgressEntry, type ProgressUnit } from "../shared/progress";

/**
 * The one progress register of the application. Every stage of a synchronization and
 * every background producer reports here what it is doing and how far it got; the API
 * returns the whole list and the screen draws from it.
 *
 * Contract:
 * - one entry per scope; a new `step` replaces the scope's previous step;
 * - `end(scope)` removes the entry once the scope has nothing left to do;
 * - entries live in small files next to the database, one per scope, written by the
 *   process that owns the scope. Workers run in other processes and threads, and a
 *   status row inside the database is invisible while the run holds its write
 *   transaction, so files are the shared medium;
 * - writing is advisory and never fails the work: a step change, a new total and the last
 *   item are written at once, other counters at most every {@link WRITE_INTERVAL_MS} and once
 *   more when the interval ends;
 * - an entry whose owning process has exited is ignored by readers.
 */
const WRITE_INTERVAL_MS = 250;
const MAX_ENTRY_BYTES = 4096;

/** The register's folder for one database; none for an in-memory database. */
export function progressDirectory(dbPath: string): string | null {
  if (!dbPath || dbPath === ":memory:") return null;
  return path.join(path.dirname(path.resolve(dbPath)), "progress");
}

// Scope names contain ':', which Windows does not allow in file names.
const fileName = (scope: string) => `${encodeURIComponent(scope).replaceAll("%", "~")}.json`;

interface Owned { entry: ProgressEntry; writtenAt: number; trailing?: ReturnType<typeof setTimeout> }

export class ProgressRegistry {
  private readonly owned = new Map<string, Owned>();
  private folderReady = false;

  constructor(private readonly directory: string | null, private readonly now: () => Date = () => new Date()) {}

  /** Starts a step of `scope`, replacing whatever step the scope reported before. */
  step(scope: string, step: string, label: string, unit: ProgressUnit, total: number | null = null, done = 0): void {
    const at = this.now().toISOString();
    const previous = this.owned.get(scope);
    if (previous?.trailing) clearTimeout(previous.trailing);
    const entry: ProgressEntry = { scope, step, label, done: count(done), total: total === null ? null : Math.max(count(total), count(done)),
      unit, startedAt: at, updatedAt: at };
    const owned: Owned = { entry, writtenAt: 0 };
    this.owned.set(scope, owned);
    this.write(owned);
  }

  /** Reports a counter of `step`: moves it while it is the scope's current step in that unit, starts it otherwise. */
  report(scope: string, step: string, label: string, unit: ProgressUnit, done: number, total: number | null): void {
    const current = this.owned.get(scope)?.entry;
    if (current?.step === step && current.unit === unit) this.advance(scope, done, total);
    else this.step(scope, step, label, unit, total, done);
  }

  /** Moves the counter of the scope's current step; a scope without a step is ignored. */
  advance(scope: string, done: number, total?: number | null): void {
    const owned = this.owned.get(scope);
    if (!owned) return;
    const entry = owned.entry, previousTotal = entry.total;
    entry.done = count(done);
    if (total !== undefined) entry.total = total === null ? null : count(total);
    if (entry.total !== null && entry.done > entry.total) entry.total = entry.done;
    entry.updatedAt = this.now().toISOString();
    const elapsed = performance.now() - owned.writtenAt;
    // A new total changes what the entry means; the last item finishes it. Both are written at once.
    if (elapsed >= WRITE_INTERVAL_MS || entry.done === entry.total || entry.total !== previousTotal) { this.write(owned); return; }
    owned.trailing ??= unrefTimer(setTimeout(() => { owned.trailing = undefined; if (this.owned.get(scope) === owned) this.write(owned); },
      WRITE_INTERVAL_MS - elapsed));
  }

  /** The scope is finished or stopped: its entry disappears. */
  end(scope: string): void {
    const owned = this.owned.get(scope);
    if (owned?.trailing) clearTimeout(owned.trailing);
    this.owned.delete(scope);
    if (!this.directory) return;
    try { fs.unlinkSync(path.join(this.directory, fileName(scope))); } catch { /* Already gone or never written. */ }
  }

  /** Ends every scope named `prefix` or `prefix:*`, including ones a crashed owner left behind. */
  endAll(prefix: string): void {
    for (const scope of [...this.owned.keys()]) if (inScope(scope, prefix)) this.end(scope);
    if (!this.directory) return;
    let names: string[];
    try { names = fs.readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      const scope = scopeOf(name);
      if (scope === null || !inScope(scope, prefix)) continue;
      // Another live process may own a scope of the same name; only its own end removes it.
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8")) as { pid?: unknown };
        if (typeof pid === "number" && pid !== process.pid && processAlive(pid)) continue;
      } catch { /* A torn file has no live owner to protect. */ }
      this.end(scope);
    }
  }

  /** The entries this registry owns, as a reader would see them. */
  entries(): ProgressEntry[] {
    return [...this.owned.values()].map(owned => ({ ...owned.entry }));
  }

  private write(owned: Owned): void {
    if (!this.directory) return;
    const file = path.join(this.directory, fileName(owned.entry.scope));
    try {
      if (!this.folderReady) { fs.mkdirSync(this.directory, { recursive: true }); this.folderReady = true; }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...owned.entry, pid: process.pid }));
      fs.renameSync(`${file}.tmp`, file);
      owned.writtenAt = performance.now();
    } catch { /* Progress never changes the outcome of the work; the next report retries. */ }
  }
}

/** Every live entry, ordered by scope. Missing folders, torn or foreign files and dead owners are skipped. */
export function readProgress(directory: string | null): ProgressEntry[] {
  if (!directory) return [];
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return []; }
  const entries: ProgressEntry[] = [];
  for (const name of names) {
    if (scopeOf(name) === null) continue;
    try {
      const file = path.join(directory, name);
      if (fs.statSync(file).size > MAX_ENTRY_BYTES) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as ProgressEntry & { pid?: unknown };
      if (!validEntry(value) || typeof value.pid !== "number" || !processAlive(value.pid)) continue;
      const { pid: _pid, ...entry } = value;
      entries.push(entry);
    } catch { /* A file being replaced is read on the next request. */ }
  }
  return entries.sort((a, b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0);
}

function scopeOf(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  try { return decodeURIComponent(name.slice(0, -5).replaceAll("~", "%")); } catch { return null; }
}
const inScope = (scope: string, prefix: string) => scope === prefix || scope.startsWith(`${prefix}:`);
const count = (value: number) => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
function unrefTimer(timer: ReturnType<typeof setTimeout>) { (timer as { unref?: () => void }).unref?.(); return timer; }

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function validEntry(value: unknown): value is ProgressEntry {
  const entry = value as ProgressEntry | null;
  const nonnegative = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return !!entry && typeof entry.scope === "string" && typeof entry.step === "string" && typeof entry.label === "string"
    && nonnegative(entry.done) && (entry.total === null || nonnegative(entry.total) && entry.total >= entry.done)
    && PROGRESS_UNITS.includes(entry.unit) && typeof entry.startedAt === "string" && typeof entry.updatedAt === "string";
}

/**
 * A background producer reports its queue, not its own counter: the backlog seen when the
 * work began is the total, and what has left the queue since is done. A queue that grows
 * raises the total; an empty queue ends the entry.
 */
export class BacklogProgress {
  private readonly totals = new Map<string, { step: string; total: number }>();
  constructor(private readonly registry: ProgressRegistry) {}

  report(scope: string, step: string, label: string, unit: ProgressUnit, pending: number): void {
    const remaining = count(pending);
    if (remaining === 0) { this.totals.delete(scope); this.registry.end(scope); return; }
    const known = this.totals.get(scope);
    const total = known?.step === step ? Math.max(known.total, remaining) : remaining;
    this.totals.set(scope, { step, total });
    this.registry.report(scope, step, label, unit, total - remaining, total);
  }
}
