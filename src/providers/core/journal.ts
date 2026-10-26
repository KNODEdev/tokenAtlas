import { hasProducerDelivery, recordProbeDelivery, type CanonicalProbe } from "../../db/probe-facts";
import { canonicalJson } from "../../config/canonical-json";
import { compactProbeLine } from "./journal-compact";
import fs from "node:fs";
import { ArchiveWritesPausedError, withArchiveFileWriter, withArchiveWriter } from "../../sync/archive-writers";
import { ensureDirectory } from "../../sync/archive-publication";
import {
  canonicalArchivePath,
  ExternalArchivePathError,
  readCanonicalArchiveRoot,
} from "../../config/archive-paths";
import path from "node:path";
import { dailyJournalFile, OBSERVATION_JOURNAL_FILE, PROBE_JOURNAL_FILE } from "./journal-files";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

/**
 * Append-only gauge journal: every probe sample this machine records is durably
 * queued and delivered as one JSON line into the shared archive
 * (`gauges/<MACHINE>-<LOGIN>/`), where the other machines ingest it. The sink
 * is off until the server configures it, so tests and one-off CLI runs never
 * touch the archive.
 */
export { OBSERVATION_JOURNAL_FILE, PROBE_JOURNAL_FILE };

export interface JournalEnvelope {
  /** Transport identity, NOT the canonical identity of the underlying measurement. */
  journal_version?: 2 | 3;
  journal_entry_id?: string;
}

export interface ProbeJournalRow extends JournalEnvelope {
  canonical_probe?: CanonicalProbe;
  provider: string;
  subject: string;
  ts: string;
  plan: string | null;
  kind: string;
  limit_group: string | null;
  scope: string | null;
  reported_percent_side: string;
  used_percent: number | null;
  remaining_percent: number | null;
  vendor_percent: number | null;
  window_minutes: number | null;
  allowance: number | null;
  used: number | null;
  remaining: number | null;
  resets_at: string | null;
  rate_limit_reached: number | null;
  reset_credits: number | null;
  profile: string | null;
  ok: number | null;
  error: string | null;
  extra: string | null;
  machine: string;
  login: string;
  source_home: string | null;
  raw_subject: string;
}

// Observation entries are no longer queued (account periods, W3); a leftover one still reaches its file.
export type JournalFile = typeof PROBE_JOURNAL_FILE | typeof OBSERVATION_JOURNAL_FILE;
type JournalRow = ProbeJournalRow;
let journalRoot: string | null = null;
let archiveRoot: string | null = null;
/** Immutable coordinates stored by future enqueue operations. */
let queuedJournalRoot: string | null = null;
let queuedArchiveRoot: string | null = null;
let queuedArchiveId: string | null = null;

/**
 * Configuration never clears durable pending work or redirects it to another archive.
 * Metadata inspection is intentionally done here, outside the fact transaction. Once an
 * archive has a path binding, enqueue stores its immutable logical coordinates so a later
 * physical relocation does not strand newly queued rows.
 */
export function configureGaugeJournal(root: string | null, options: { archiveRoot?: string } = {}): void {
  journalRoot = root == null ? null : path.resolve(root);
  archiveRoot = options.archiveRoot == null ? null : path.resolve(options.archiveRoot);
  queuedJournalRoot = journalRoot;
  queuedArchiveRoot = archiveRoot;
  queuedArchiveId = null;
  if (journalRoot == null || archiveRoot == null) return;
  const binding = readCanonicalArchiveRoot(archiveRoot);
  if (!binding) return;
  try {
    queuedJournalRoot = canonicalArchivePath(binding, journalRoot);
    queuedArchiveRoot = binding.originalLogicalRoot;
    queuedArchiveId = binding.archiveId;
  } catch (error) {
    // An explicit journal outside the archive retains its exact-path legacy semantics.
    if (!(error instanceof ExternalArchivePathError)) throw error;
  }
}
export function gaugeJournalRoot(): string | null { return journalRoot; }

export function pendingGaugeJournalLines(sqlite: Database): number {
  return (sqlite.query("SELECT count(*) AS n FROM gauge_journal_outbox").get() as { n: number }).n;
}

export interface GaugeJournalOutboxStatus { pending: number; oldestQueuedAt: string | null }
/**
 * Bounded backlog reading for status responses: two aggregates, never payloads or paths.
 * A queue that stops draining is a silent data-delivery failure otherwise.
 */
export function gaugeJournalOutboxStatus(sqlite: Database): GaugeJournalOutboxStatus {
  if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gauge_journal_outbox'").get()) {
    return { pending: 0, oldestQueuedAt: null };
  }
  const row = sqlite.query("SELECT count(*) AS pending, min(queued_at) AS oldest FROM gauge_journal_outbox")
    .get() as { pending: number; oldest: string | null };
  return { pending: row.pending, oldestQueuedAt: row.oldest };
}

/**
 * The last self-contained line this process queued per counter, which later readings of the same
 * UTC day may reference instead of repeating (journal-compact.ts). Memory only: after a restart
 * the next reading is self-contained again. An entry is trusted only once its producer delivery
 * is committed, so a rolled-back fact transaction can never become a base.
 */
const compactBases = new Map<string, { entryId: string; fact: CanonicalProbe; day: string }>();

/** Must run INSIDE the same transaction as the corresponding local fact write. No archive I/O. */
export function enqueueGaugeJournal(sqlite: Database, file: JournalFile, rows: ReadonlyArray<JournalRow>): void {
  if (journalRoot == null || rows.length === 0) return;
  if (!sqlite.inTransaction) throw new Error("Journal enqueue requires the fact transaction");
  // Legacy indexes can queue/deliver at their configured physical target. Only a
  // proven archive binding may convert newly queued work to logical coordinates.
  const logical = queuedArchiveId != null && boundArchiveIdentity(sqlite) === queuedArchiveId;
  const insert = sqlite.query(`INSERT INTO gauge_journal_outbox
    (entry_id, journal_root, archive_root, file_name, payload, queued_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    const entryId = randomUUID();
    const fact = "canonical_probe" in row ? row.canonical_probe : undefined;
    let payload: string;
    if (fact) {
      const day = new Date().toISOString().slice(0, 10);
      const key = canonicalJson([journalRoot, fact.header.machine, fact.header.login, fact.header.subject, fact.discriminator]);
      const prior = compactBases.get(key);
      const base = prior && prior.day === day && hasProducerDelivery(sqlite, prior.fact.counter_id, prior.entryId) ? prior.fact : null;
      const compact = compactProbeLine(entryId, fact, base);
      if (compact.full) compactBases.set(key, { entryId, fact, day });
      payload = compact.line;
    } else payload = JSON.stringify({ ...row, journal_version: 2, journal_entry_id: entryId });
    // Bound memory and write batches without silently truncating evidence.
    if (Buffer.byteLength(payload, "utf8") > 64 * 1024) throw new Error("Journal entry exceeds 64 KiB");
    insert.run(entryId, logical ? queuedJournalRoot : journalRoot, logical ? queuedArchiveRoot : archiveRoot, file, payload,
      new Date().toISOString());
    if (fact) recordProbeDelivery(sqlite, fact, entryId, { entry_id: entryId, payload, received_at: new Date().toISOString(), role: "producer" });
  }
}

export interface JournalDeliveryTarget { journalRoot: string; archiveRoot: string | null }
interface PendingRow { id: number; file_name: JournalFile; payload: string }
interface StoredDeliveryTarget { journalRoot: string; archiveRoot: string | null }
/**
 * Bounded failure classes. `delivery-failed` used to absorb every cause, which hid a
 * queue that had stopped draining for a knowable reason (a paused archive, a locked
 * local database, a read-only target) behind one console warning.
 */
export type JournalDeliveryError = "archive-unavailable" | "archive-paused" | "archive-forbidden"
  | "database-busy" | "delivery-failed";
export interface JournalDeliveryResult { delivered: number; error: JournalDeliveryError | null; cause?: string }

/**
 * What an unclassified failure was, for the console only: the error name, its errno code and the
 * message up to its first colon. Paths, vendor messages and payloads follow that colon.
 */
function unclassifiedCause(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as NodeJS.ErrnoException).code;
  return [error.name, code, error.message.split(":")[0]!.slice(0, 80)].filter(Boolean).join(" / ");
}

/** Classification only: no paths, vendor messages or payloads leave this function. */
function classifyDeliveryFailure(error: unknown): JournalDeliveryError {
  if (error instanceof ArchiveWritesPausedError) return "archive-paused";
  const code = (error as NodeJS.ErrnoException | { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code === "SQLITE_BUSY_SNAPSHOT") return "database-busy";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "archive-forbidden";
  const message = error instanceof Error ? error.message : "";
  if (/database is locked|database table is locked|database schema is locked/i.test(message)) return "database-busy";
  if (/Relocation destination is staged/.test(message)) return "archive-paused";
  return "delivery-failed";
}

function boundArchiveIdentity(sqlite: Database): string | null {
  if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) return null;
  return (sqlite.query("SELECT value FROM meta WHERE key='archive:identity'").get() as
    { value: string } | null)?.value ?? null;
}
function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function uniqueTargets(targets: StoredDeliveryTarget[]): StoredDeliveryTarget[] {
  const unique = new Map<string, StoredDeliveryTarget>();
  for (const target of targets) {
    const key = `${pathKey(target.journalRoot)}\0${target.archiveRoot == null ? "" : pathKey(target.archiveRoot)}`;
    unique.set(key, target);
  }
  return [...unique.values()];
}

/**
 * Resolve only coordinates proven to belong to this database's currently bound archive.
 * A copied path binding proves that its immutable logical root and the current physical root
 * are the same archive, while `archive:identity` prevents a path-string coincidence from
 * redirecting another archive's pending rows. Missing identity proof leaves rows pending.
 */
function storedDeliveryTargets(sqlite: Database, root: string, archive: string | null): StoredDeliveryTarget[] {
  if (archive == null) return [{ journalRoot: root, archiveRoot: null }];
  const binding = readCanonicalArchiveRoot(archive);
  if (!binding) return [{ journalRoot: root, archiveRoot: archive }];
  const identity = boundArchiveIdentity(sqlite);
  // Pinning the original root must not stop legacy exact-target delivery before
  // setup binds the index. Moving work to another path still requires identity proof.
  if (identity !== binding.archiveId) return identity == null
    ? [{ journalRoot: root, archiveRoot: archive }] : [];
  const targets: StoredDeliveryTarget[] = [{ journalRoot: root, archiveRoot: archive }];
  try {
    targets.push({
      journalRoot: canonicalArchivePath(binding, root),
      archiveRoot: binding.originalLogicalRoot,
    });
  } catch (error) {
    if (!(error instanceof ExternalArchivePathError)) throw error;
  }
  return uniqueTargets(targets);
}

/** Append-only recovery: separate any torn final line, never truncate an existing journal. */
function appendDurably(filePath: string, rows: PendingRow[]): void {
  const fd = fs.openSync(filePath, "a+", 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size > 0) fs.readSync(fd, last, 0, 1, size - 1);
    const prefix = size > 0 && last[0] !== 10 ? "\n" : "";
    const bytes = Buffer.from(prefix + rows.map(row => row.payload).join("\n") + "\n", "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (n <= 0) throw new Error("Incomplete journal write");
      offset += n;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/**
 * At-least-once delivery. Run on the dedicated worker connection, NEVER from a GET or
 * the fact writer. IMMEDIATE serializes drainers of this local database, including file
 * appends. A crash after fsync but before commit retries the SAME entry IDs; receivers
 * deduplicate those IDs. Bound each transaction to <=16 rows / <=1 MiB.
 * This is not a cloud delivery acknowledgment or a hard filesystem latency guarantee.
 */
export function flushGaugeJournal(sqlite: Database, target: JournalDeliveryTarget, maxRows = 16): JournalDeliveryResult {
  if (sqlite.inTransaction) throw new Error("Journal delivery requires an independent committed connection");
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 16) throw new Error("Invalid journal batch size");
  const root = path.resolve(target.journalRoot);
  const archive = target.archiveRoot == null ? null : path.resolve(target.archiveRoot);
  let unavailable = false;
  try {
    if (archive != null && !fs.existsSync(archive)) {
      unavailable = true;
      throw new Error("Archive unavailable");
    }
    const storedTargets = storedDeliveryTargets(sqlite, root, archive);
    if (!storedTargets.length) return { delivered: 0, error: null };
    const clauses = storedTargets.map(() => "(journal_root = ? AND archive_root IS ?)").join(" OR ");
    const bindings = storedTargets.flatMap((target) => [target.journalRoot, target.archiveRoot]);
    const deliver = () => sqlite.transaction(() => {
      const rows = sqlite.query(`SELECT id, file_name, payload FROM gauge_journal_outbox
        WHERE (${clauses}) ORDER BY id LIMIT ?`).all(...bindings, maxRows) as PendingRow[];
      if (!rows.length) return 0;
      if (archive != null && !fs.existsSync(archive)) {
        unavailable = true;
        throw new Error("Archive unavailable");
      }
      ensureDirectory(root);
      for (const file of [PROBE_JOURNAL_FILE, OBSERVATION_JOURNAL_FILE] as const) {
        const batch = rows.filter(row => row.file_name === file);
        // The outbox names the journal kind; the file is today's segment of it (journal-files.ts).
        if (batch.length) appendDurably(path.join(root, dailyJournalFile(file, new Date())), batch);
      }
      if (rows.some(row => row.file_name !== PROBE_JOURNAL_FILE && row.file_name !== OBSERVATION_JOURNAL_FILE)) {
        throw new Error("Unknown journal kind");
      }
      const ack = sqlite.query("DELETE FROM gauge_journal_outbox WHERE id = ?");
      for (const row of rows) ack.run(row.id);
      return rows.length;
    }).immediate();
    const delivered = archive == null
      ? withArchiveFileWriter(path.join(root, PROBE_JOURNAL_FILE), deliver)
      : withArchiveWriter(archive, deliver);
    return { delivered, error: null };
  } catch (error) {
    // No arbitrary filesystem paths, vendor messages or serialized payloads in diagnostics.
    const failure = unavailable ? "archive-unavailable" : classifyDeliveryFailure(error);
    return { delivered: 0, error: failure, ...(failure === "delivery-failed" ? { cause: unclassifiedCause(error) } : {}) };
  }
}
