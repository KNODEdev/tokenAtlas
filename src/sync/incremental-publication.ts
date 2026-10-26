import { Database } from "../db/sqlite";
import type { VendorId } from "./contracts";
import { directChanges } from "../db/change-count";
import type { SQLQueryBindings } from "../db/sqlite";
import type { DeltaIdentity } from "./vendor-publication-schema";
import type { PublicationReport } from "./vendor-progress";
import { DELTA_SPECS, vendorSourceTables } from "./vendor-publication-schema";
import { tableColumns, fingerprintColumns, quoteIdentifier } from "./sync-sql";
import { identityWhere, sourceImpactIdentities, identityKey } from "./publication-identities";
import type { SourceImpactObservation } from "./source-impact";
import { beginSourceImpactObservation } from "./source-impact";
import { markCodexLedgerCopiesDirty } from "../db/codex-ledger-producer";
import { markLimitWindowFilesDirty } from "../db/limit-windows";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { publishClaudeChangedSourceRows } from "./claude-source-publication";

/** Preserve unchanged rows (including duplicate multiplicity) and their change clocks. */
function publishChangedSourceRows(
  active: Database,
  staged: Database,
  vendor: VendorId,
  identities: DeltaIdentity[],
  attachedSource?: string,
  report?: PublicationReport,
): void {
  const spec = DELTA_SPECS[vendor];
  const plans = vendorSourceTables(vendor).map(table => {
    const columns = tableColumns(active, table).filter(column => column !== "id");
    const removed: string[] = [], added: string[] = [];
    const fingerprint = (row: Record<string, unknown>) => JSON.stringify(columns.map(column => row[column]));
    for (const identity of identities) {
      const where = identityWhere(spec, identity);
      const sql = `SELECT CAST(rowid AS TEXT) AS __publication_rowid, ${fingerprintColumns(columns)}
        FROM ${quoteIdentifier(table)} WHERE ${where.sql}`;
      const remaining = new Map<string, string[]>();
      for (const row of active.query(sql).iterate(...where.params) as Iterable<Record<string, string>>) {
        const key = fingerprint(row), rows = remaining.get(key) ?? [];
        rows.push(row.__publication_rowid!); remaining.set(key, rows);
      }
      for (const row of staged.query(sql).iterate(...where.params) as Iterable<Record<string, string>>) {
        const rows = remaining.get(fingerprint(row));
        if (rows?.length) rows.pop();
        else added.push(row.__publication_rowid!);
      }
      for (const rows of remaining.values()) removed.push(...rows);
    }
    return { table, columns, removed, added };
  });
  // Delete across all affected identities before inserting a call moved between files.
  const total = plans.reduce((sum, plan) => sum + plan.removed.length + plan.added.length, 0);
  let completed = 0;
  report?.("write", completed, total);
  for (const plan of plans) {
    const remove = active.query(`DELETE FROM ${quoteIdentifier(plan.table)} WHERE rowid=?`);
    for (const rowid of plan.removed) {
      remove.run(rowid);
      if (++completed % 400 === 0) report?.("write", completed, total);
    }
  }
  for (const plan of plans) {
    if (!plan.added.length) continue;
    if (attachedSource) {
      const available = new Set(tableColumns(staged, plan.table));
      using insert = active.prepare(`INSERT INTO ${quoteIdentifier(plan.table)} (${plan.columns.map(quoteIdentifier).join(",")})
        SELECT ${plan.columns.map(column => available.has(column) ? `s.${quoteIdentifier(column)}` : "NULL").join(",")}
        FROM json_each(?) j JOIN ${quoteIdentifier(attachedSource)}.${quoteIdentifier(plan.table)} s
          ON s.rowid=CAST(j.value AS INTEGER) ORDER BY j.key`);
      // Rowids remain decimal strings in JSON, preserving the full SQLite INTEGER range.
      for (let offset=0;offset<plan.added.length;offset+=400) {
        const rowids=plan.added.slice(offset,offset+400);
        insert.run(JSON.stringify(rowids));
        if (directChanges(active)!==rowids.length) throw new Error(`Staged source row disappeared: ${plan.table}`);
        completed += rowids.length;
        report?.("write", completed, total);
      }
      continue;
    }
    const read = staged.query(`SELECT * FROM ${quoteIdentifier(plan.table)} WHERE rowid=?`);
    const insert = active.query(`INSERT INTO ${quoteIdentifier(plan.table)} (${plan.columns.map(quoteIdentifier).join(",")})
      VALUES (${plan.columns.map(() => "?").join(",")})`);
    for (const rowid of plan.added) {
      const row = read.get(rowid) as Record<string, SQLQueryBindings> | null;
      if (!row) throw new Error(`Staged source row disappeared: ${plan.table}`);
      insert.run(...plan.columns.map(column => row[column] ?? null));
      if (++completed % 400 === 0) report?.("write", completed, total);
    }
  }
  report?.("write", completed, total);
}

export function publishIncrementalDelta(
  active: Database,
  stage: Database,
  vendor: VendorId,
  identities: DeltaIdentity[],
  changedIdentities: DeltaIdentity[],
  commitMetadata: (impact: SourceImpactObservation) => void,
  beforeMutation: () => void = () => {},
  preserveUnchangedRows = false,
  report?: PublicationReport,
): void {
  const spec = DELTA_SPECS[vendor];
  const bookmarkRows: Array<Record<string, SQLQueryBindings>> = [];
  if (spec.bookmarkTable) {
    for (const identity of identities) {
      const where = identityWhere(spec, identity);
      const row = stage
        .query(`SELECT * FROM ${quoteIdentifier(spec.bookmarkTable)} WHERE ${where.sql}`)
        .get(...where.params) as Record<string, SQLQueryBindings> | null;
      if (row) bookmarkRows.push(row);
    }
  }
  // Keep INTEGER values lossless while streaming rows between connections.
  const facts = new Database(stage.filename, { readonly: true, safeIntegers: true });
  let attachedSource: string | undefined;
  const write = () => {
    beforeMutation();
    const impactIdentities = sourceImpactIdentities(active, facts, vendor, changedIdentities);
    const impact = beginSourceImpactObservation(active, vendor, {
      identityColumns: spec.identity,
      identities: impactIdentities,
    });
    try {
    if (changedIdentities.length && vendor === "claude") {
      publishClaudeChangedSourceRows(active, facts, changedIdentities);
    } else if (changedIdentities.length && preserveUnchangedRows) {
      publishChangedSourceRows(active, facts, vendor, changedIdentities, attachedSource, report);
    } else if (changedIdentities.length) {
      for (const identity of changedIdentities) {
        const where = identityWhere(spec, identity);
        if (vendor === "claude") {
          const callIds = stage
            .query(`SELECT call_id FROM claude_events WHERE ${where.sql}`)
            .all(...where.params) as Array<{ call_id: string }>;
          const removeCall = active.query("DELETE FROM claude_events WHERE store = ? AND call_id = ?");
          for (const row of callIds) removeCall.run(String(identity.store), row.call_id);
        }
        for (const table of vendorSourceTables(vendor)) {
          active.query(`DELETE FROM ${quoteIdentifier(table)} WHERE ${where.sql}`).run(...where.params);
        }
      }
      for (const table of vendorSourceTables(vendor)) {
        const columns = tableColumns(active, table).filter((column) => column !== "id");
        const insert = active.query(
          `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`
        );
        // Stream validated facts instead of retaining the entire archive in JS memory.
        for (const identity of changedIdentities) {
          const where = identityWhere(spec, identity);
          const rows = facts.query(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${where.sql}`)
            .iterate(...where.params) as Iterable<Record<string, SQLQueryBindings>>;
          for (const row of rows) insert.run(...columns.map(column => row[column] ?? null));
        }
      }
    }
    if (spec.bookmarkTable) {
      const columns = tableColumns(active, spec.bookmarkTable);
      const evidenceColumns = columns.filter(column => column !== "ingested_at");
      const bookmarkEvidence = `SELECT ${fingerprintColumns(evidenceColumns)} FROM ${quoteIdentifier(spec.bookmarkTable)}`;
      const stagedRows = new Map(bookmarkRows.map(row => [identityKey(spec, row), row]));
      const insert = active.query(
        `INSERT INTO ${quoteIdentifier(spec.bookmarkTable)} (${columns.map(quoteIdentifier).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`
      );
      for (const identity of identities) {
        const where = identityWhere(spec, identity);
        const select = `${bookmarkEvidence} WHERE ${where.sql}`;
        const before = active.query(select).get(...where.params);
        const after = stage.query(select).get(...where.params);
        // Reread telemetry alone is not a new source witness or a reason to rewrite its row.
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        active.query(`DELETE FROM ${quoteIdentifier(spec.bookmarkTable)} WHERE ${where.sql}`).run(...where.params);
        const row = stagedRows.get(identityKey(spec, identity));
        if (row) insert.run(...columns.map((column) => row[column] ?? null));
      }
    } else {
      const replace = active.query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      for (const identity of identities) {
        const key = `opencode_snapshot:${identity.store}`;
        const row = stage.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
        if (row) replace.run(key, row.value);
      }
    }
    if (vendor === "codex" && changedIdentities.length) markCodexLedgerCopiesDirty(active,
      changedIdentities.map(identity => ({ home: String(identity.home), path: String(identity.path) })));
    // A changed transcript can change its session readings and the models that admit them.
    if (vendor === "codex" && changedIdentities.length) markLimitWindowFilesDirty(active,
      changedIdentities.map(identity => ({ home: String(identity.home), path: String(identity.path) })));
    report?.("finalize");
    commitMetadata(impact);
    report?.("commit");
    } finally {
      impact.dispose();
    }
  };
  try {
    // Attach before the transaction so failure or commit can release its read snapshot.
    if (changedIdentities.length && preserveUnchangedRows && vendor !== "claude" && !active.inTransaction) {
      const alias = "__tokenatlas_publish_source";
      active.query(`ATTACH DATABASE ? AS ${quoteIdentifier(alias)}`)
        .run(`${pathToFileURL(path.resolve(stage.filename)).href}?mode=ro`);
      attachedSource = alias;
    }
    active.transaction(write).immediate();
  } finally {
    try { if (attachedSource) active.exec(`DETACH DATABASE ${quoteIdentifier(attachedSource)}`); }
    finally { facts.close(); }
  }
}
