import { Database, type SQLQueryBindings } from "../db/sqlite";
import type {
  ExactSourceImpactMetric,
  SourceImpactTableEvidence,
  VendorId,
  VendorSourceImpact,
} from "./contracts";

type SourceIdentity = Record<string, string | number>;

export interface SourceImpactScope {
  identityColumns: readonly string[];
  identities?: readonly SourceIdentity[];
}

interface TableSpec {
  table: string;
  keyColumns: readonly string[];
}

const TABLE_SPECS: Partial<Record<VendorId, readonly TableSpec[]>> = {
  codex: [
    { table: "events", keyColumns: ["home", "path", "source_offset"] },
    { table: "ratelimit", keyColumns: ["home", "path", "source_offset", "source_slot"] },
  ],
  claude: [{ table: "claude_events", keyColumns: ["store", "call_id"] }],
  opencode: [{ table: "oc_events", keyColumns: ["store", "message_id"] }],
  grok: [{ table: "grok_events", keyColumns: ["store", "source_id", "session_id", "prompt_id", "model"] }],
  gemini: [{ table: "gemini_events", keyColumns: ["store", "conversation_id", "gen_idx"] }],
};

// Source impact is auxiliary evidence and must never make publication retain an
// unbounded second copy of provider history in SQLite's in-memory temp store.
const MAX_CAPTURE_ROWS = 25_000n;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

let observationSequence = 0;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(sqlite: Database, table: string): boolean {
  return Boolean(sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(sqlite: Database, table: string): string[] {
  return (sqlite.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map(row => row.name);
}

function available(value: string): ExactSourceImpactMetric {
  return { status: "available", value, reason: null };
}

function unavailable(reason: string): ExactSourceImpactMetric {
  return { status: "unavailable", value: null, reason };
}

const CANONICAL_UNKNOWN = "cross-copy-canonicality-not-proven-by-source-publication";
const DUPLICATES_UNKNOWN = "no-explicit-trustworthy-duplicate-candidate-collapse";

export function unchangedSourceImpact(): VendorSourceImpact {
  return {
    basis: "source-record-semantic-diff-v1",
    scope: "no-publication",
    sourceFactsChanged: available("0"),
    sourceCorrections: available("0"),
    sourceDeletions: available("0"),
    canonicalFacts: unavailable(CANONICAL_UNKNOWN),
    duplicates: unavailable(DUPLICATES_UNKNOWN),
    evidence: [],
  };
}

export function unavailableSourceImpact(reason: string, published = false): VendorSourceImpact {
  return {
    basis: "source-record-semantic-diff-v1",
    scope: published ? "published-source-identities" : "no-publication",
    sourceFactsChanged: unavailable(reason),
    sourceCorrections: unavailable(reason),
    sourceDeletions: unavailable(reason),
    canonicalFacts: unavailable(CANONICAL_UNKNOWN),
    duplicates: unavailable(DUPLICATES_UNKNOWN),
    evidence: [],
  };
}

function encodedTuple(row: Record<string, unknown>, prefix: string, count: number): string {
  const values: Array<[string, string]> = [];
  for (let index = 0; index < count; index++) {
    values.push([String(row[`${prefix}t${index}`]), String(row[`${prefix}q${index}`])]);
  }
  return JSON.stringify(values);
}

function tupleProjection(alias: string, columns: readonly string[], prefix: string): string[] {
  return columns.flatMap((column, index) => [
    `typeof(${alias}.${quoteIdentifier(column)}) AS ${quoteIdentifier(`${prefix}t${index}`)}`,
    `quote(${alias}.${quoteIdentifier(column)}) AS ${quoteIdentifier(`${prefix}q${index}`)}`,
  ]);
}

function countText(sqlite: Database, sql: string, ...bindings: SQLQueryBindings[]): string {
  const statement = sqlite.prepare(sql);
  try {
    const row = statement.get(...bindings) as { value: string } | null;
    return row?.value ?? "0";
  } finally {
    statement.finalize();
  }
}

export class SourceImpactObservation {
  readonly #sqlite: Database;
  readonly #vendor: VendorId;
  readonly #scope: SourceImpactScope;
  readonly #prefix: string;
  readonly #before: string;
  readonly #after: string;
  readonly #scopeTable: string | null;
  readonly #evidence: SourceImpactTableEvidence[] = [];
  #capturedRows = 0n;
  #capturedBytes = 0;
  #finished = false;
  #disposed = false;

  constructor(sqlite: Database, vendor: VendorId, scope: SourceImpactScope) {
    this.#sqlite = sqlite;
    this.#vendor = vendor;
    this.#scope = scope;
    this.#prefix = `source_impact_${process.pid}_${++observationSequence}`;
    this.#before = `${this.#prefix}_before`;
    this.#after = `${this.#prefix}_after`;
    this.#scopeTable = scope.identities ? `${this.#prefix}_scope` : null;
    try {
      this.#createStorage();
      this.#capture(this.#before, "before");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  #createStorage(): void {
    for (const table of [this.#before, this.#after]) {
      this.#sqlite.exec(`CREATE TEMP TABLE ${quoteIdentifier(table)} (
        table_name TEXT NOT NULL,
        record_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(table_name, record_key)
      )`);
    }
    if (!this.#scopeTable) return;
    const columns = this.#scope.identityColumns.map((_, index) => `${quoteIdentifier(`c${index}`)}`).join(",");
    this.#sqlite.exec(`CREATE TEMP TABLE ${quoteIdentifier(this.#scopeTable)} (${columns})`);
    const insert = this.#sqlite.prepare(`INSERT INTO ${quoteIdentifier(this.#scopeTable)} VALUES (${this.#scope.identityColumns.map(() => "?").join(",")})`);
    try {
      for (const identity of this.#scope.identities ?? []) {
        insert.run(...this.#scope.identityColumns.map(column => identity[column] as SQLQueryBindings));
      }
    } finally {
      insert.finalize();
    }
  }

  #capture(target: string, phase: "before" | "after"): void {
    const specs = TABLE_SPECS[this.#vendor];
    if (!specs?.length) {
      if (!this.#evidence.some(item => item.table === "")) this.#evidence.push({
        provider: this.#vendor,
        table: "",
        keyColumns: [],
        semanticColumns: [],
        status: "unavailable",
        reason: "provider-has-no-trustworthy-source-record-key-contract",
        beforeRecords: null,
        afterRecords: null,
        additions: null,
        corrections: null,
        deletions: null,
      });
      return;
    }
    for (const spec of specs) {
      let evidence = this.#evidence.find(item => item.table === spec.table);
      if (!evidence) {
        evidence = {
          provider: this.#vendor,
          table: spec.table,
          keyColumns: [...spec.keyColumns],
          semanticColumns: [],
          status: "available",
          reason: null,
          beforeRecords: null,
          afterRecords: null,
          additions: null,
          corrections: null,
          deletions: null,
        };
        this.#evidence.push(evidence);
      }
      if (evidence.status === "unavailable") continue;
      if (!tableExists(this.#sqlite, spec.table)) {
        evidence.status = "unavailable";
        evidence.reason = `missing-source-table:${spec.table}`;
        continue;
      }
      const columns = tableColumns(this.#sqlite, spec.table).filter(column => column !== "id");
      evidence.semanticColumns = columns;
      const missing = [...spec.keyColumns, ...this.#scope.identityColumns].filter(column => !columns.includes(column));
      if (missing.length) {
        evidence.status = "unavailable";
        evidence.reason = `missing-trustworthy-key-columns:${missing.join(",")}`;
        continue;
      }
      const alias = "source_row";
      const source = `${quoteIdentifier(spec.table)} AS ${alias}`;
      // CROSS JOIN fixes the small selected-identity table as the outer loop. The
      // provider table is reached through its source identity index, never scanned.
      const from = this.#scopeTable
        ? `${quoteIdentifier(this.#scopeTable)} AS selected CROSS JOIN ${source}
           WHERE ${this.#scope.identityColumns
            .map((column, index) => `${alias}.${quoteIdentifier(column)} IS selected.${quoteIdentifier(`c${index}`)}`).join(" AND ")}`
        : source;
      const projection = [
        ...tupleProjection(alias, spec.keyColumns, "k"),
        ...tupleProjection(alias, columns, "v"),
      ].join(",");
      const selectSql = `SELECT ${projection} FROM ${from}`;
      if (this.#scopeTable) {
        const plan = this.#sqlite.prepare(`EXPLAIN QUERY PLAN ${selectSql}`);
        let bounded = false;
        try {
          const details = (plan.all() as Array<{ detail: string }>).map(row => row.detail);
          const access = details.find(detail => /\bSEARCH source_row\b/i.test(detail));
          const escapes = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          bounded = !!access && !/\bAUTOMATIC\b/i.test(access) && this.#scope.identityColumns.every(column =>
            new RegExp(`\\b${escapes(column)}=\\?`, "i").test(access));
        } finally {
          plan.finalize();
        }
        if (!bounded) {
          evidence.status = "unavailable";
          evidence.reason = `unbounded-source-scan:${spec.table}`;
          continue;
        }
      }
      // Estimate a conservative upper bound without returning payloads to JS.
      // Six bytes per input byte covers JSON escaping (including control bytes),
      // SQL quoting and BLOB hex encoding; the constant covers tuple/type syntax.
      const retainedColumns = [...spec.keyColumns, ...columns];
      const estimatedRowBytes = retainedColumns.map(column =>
        `(64 + 6 * COALESCE(length(CAST(${alias}.${quoteIdentifier(column)} AS BLOB)), 0))`
      ).join(" + ") || "0";
      const preflight = this.#sqlite.prepare(
        `SELECT CAST(count(*) AS TEXT) AS rows, total(${estimatedRowBytes}) AS bytes FROM ${from}`
      );
      let estimated: { rows: string; bytes: number };
      try {
        estimated = preflight.get() as { rows: string; bytes: number };
      } finally {
        preflight.finalize();
      }
      const estimatedRows = BigInt(estimated.rows);
      const estimatedBytes = estimated.bytes;
      const rowLimitExceeded = this.#capturedRows + estimatedRows > MAX_CAPTURE_ROWS;
      const byteLimitExceeded = !Number.isFinite(estimatedBytes)
        || this.#capturedBytes + estimatedBytes > MAX_CAPTURE_BYTES;
      if (rowLimitExceeded || byteLimitExceeded) {
        evidence.status = "unavailable";
        evidence.reason = rowLimitExceeded
          ? `source-impact-capture-row-limit:${MAX_CAPTURE_ROWS}`
          : `source-impact-capture-byte-limit:${MAX_CAPTURE_BYTES}`;
        continue;
      }
      this.#capturedRows += estimatedRows;
      this.#capturedBytes += estimatedBytes;
      const insert = this.#sqlite.prepare(`INSERT INTO ${quoteIdentifier(target)} (table_name,record_key,payload) VALUES (?,?,?)`);
      const select = this.#sqlite.prepare(selectSql);
      let captureError: unknown = null;
      try {
        for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
          if (spec.keyColumns.some((_, index) => row[`kt${index}`] === "null")) {
            throw new Error("null-trustworthy-record-key");
          }
          insert.run(spec.table, encodedTuple(row, "k", spec.keyColumns.length), encodedTuple(row, "v", columns.length));
        }
        const count = countText(this.#sqlite,
          `SELECT CAST(count(*) AS TEXT) AS value FROM ${quoteIdentifier(target)} WHERE table_name=?`, spec.table);
        if (phase === "before") evidence.beforeRecords = count;
        else evidence.afterRecords = count;
      } catch (error) {
        captureError = error;
      } finally {
        select.finalize();
        insert.finalize();
      }
      if (captureError != null) {
        evidence.status = "unavailable";
        const message = captureError instanceof Error ? captureError.message : String(captureError);
        evidence.reason = message.includes("UNIQUE constraint failed")
          ? "ambiguous-trustworthy-record-key"
          : message;
        const remove = this.#sqlite.prepare(`DELETE FROM ${quoteIdentifier(target)} WHERE table_name=?`);
        try { remove.run(spec.table); } finally { remove.finalize(); }
      }
    }
  }

  finish(): VendorSourceImpact {
    if (this.#finished) throw new Error("Source impact observation was already finished");
    this.#finished = true;
    this.#capture(this.#after, "after");
    const failed = this.#evidence.find(item => item.status === "unavailable");
    if (failed) {
      const reason = `source-record-key-evidence-unavailable:${failed.table || this.#vendor}:${failed.reason}`;
      return {
        ...unavailableSourceImpact(reason, true),
        evidence: this.#evidence.map(item => ({ ...item })),
      };
    }
    let additions = 0n;
    let corrections = 0n;
    let deletions = 0n;
    for (const evidence of this.#evidence) {
      evidence.additions = countText(this.#sqlite, `SELECT CAST(count(*) AS TEXT) AS value
        FROM ${quoteIdentifier(this.#after)} a LEFT JOIN ${quoteIdentifier(this.#before)} b
          ON b.table_name=a.table_name AND b.record_key=a.record_key
        WHERE a.table_name=? AND b.record_key IS NULL`, evidence.table);
      evidence.corrections = countText(this.#sqlite, `SELECT CAST(count(*) AS TEXT) AS value
        FROM ${quoteIdentifier(this.#after)} a JOIN ${quoteIdentifier(this.#before)} b
          ON b.table_name=a.table_name AND b.record_key=a.record_key
        WHERE a.table_name=? AND a.payload<>b.payload`, evidence.table);
      evidence.deletions = countText(this.#sqlite, `SELECT CAST(count(*) AS TEXT) AS value
        FROM ${quoteIdentifier(this.#before)} b LEFT JOIN ${quoteIdentifier(this.#after)} a
          ON a.table_name=b.table_name AND a.record_key=b.record_key
        WHERE b.table_name=? AND a.record_key IS NULL`, evidence.table);
      additions += BigInt(evidence.additions);
      corrections += BigInt(evidence.corrections);
      deletions += BigInt(evidence.deletions);
    }
    return {
      basis: "source-record-semantic-diff-v1",
      scope: "published-source-identities",
      sourceFactsChanged: available(String(additions + corrections + deletions)),
      sourceCorrections: available(String(corrections)),
      sourceDeletions: available(String(deletions)),
      canonicalFacts: unavailable(CANONICAL_UNKNOWN),
      duplicates: unavailable(DUPLICATES_UNKNOWN),
      evidence: this.#evidence.map(item => ({ ...item })),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const table of [this.#before, this.#after, this.#scopeTable]) {
      if (table) this.#sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    }
  }
}

export function beginSourceImpactObservation(
  sqlite: Database,
  vendor: VendorId,
  scope: SourceImpactScope,
): SourceImpactObservation {
  return new SourceImpactObservation(sqlite, vendor, scope);
}
