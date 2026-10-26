import type { SQLQueryBindings, Database } from "../db/sqlite";
import { markLimitWindowsDirty, ALL_ACCOUNTS } from "../db/limit-windows";
import type { DeltaIdentity } from "./vendor-publication-schema";
import { tableColumns, fingerprintColumns, quoteIdentifier } from "./sync-sql";
import { identityWhere, identityKey } from "./publication-identities";
import { DELTA_SPECS } from "./vendor-publication-schema";
import { CLAUDE_CLOUD_ENTRYPOINT } from "../ingest/claude-cloud";

export type ClaudePublicationRow = Record<string, SQLQueryBindings>;

function claudePublicationText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

function claudePublicationInteger(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}

export function compareClaudePublicationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareClaudePublicationRows(
  left: ClaudePublicationRow,
  right: ClaudePublicationRow,
  columns: string[],
): number {
  // A cloud reading carries its output in per-turn rows, so its call row is the copy to keep, place included.
  const cloud = Number(claudePublicationText(right.entrypoint) === CLAUDE_CLOUD_ENTRYPOINT)
    - Number(claudePublicationText(left.entrypoint) === CLAUDE_CLOUD_ENTRYPOINT);
  if (cloud !== 0) return cloud;
  const output = claudePublicationInteger(right.out_total) - claudePublicationInteger(left.out_total);
  if (output !== 0n) return output < 0n ? -1 : 1;
  const leftPath = claudePublicationText(left.path);
  const rightPath = claudePublicationText(right.path);
  const lowerPath = compareClaudePublicationText(leftPath.toLowerCase(), rightPath.toLowerCase());
  if (lowerPath !== 0) return lowerPath;
  const path = compareClaudePublicationText(leftPath, rightPath);
  if (path !== 0) return path;
  const leftFingerprint = columns.map(column => `${column}=${claudePublicationText(left[column])}`).join("\\0");
  const rightFingerprint = columns.map(column => `${column}=${claudePublicationText(right[column])}`).join("\\0");
  return compareClaudePublicationText(leftFingerprint, rightFingerprint);
}

export function mergeClaudePublicationRows(
  rows: ClaudePublicationRow[],
  columns: string[],
): ClaudePublicationRow {
  const ordered = [...rows].sort((left, right) => compareClaudePublicationRows(left, right, columns));
  const winner = { ...ordered[0] };
  const accountKeys = [...new Set(rows
    .map(row => row.account_key == null ? null : claudePublicationText(row.account_key))
    .filter((value): value is string => value !== null && value !== ""))]
    .sort(compareClaudePublicationText);
  // `subscription_id` is evidence only where a session identity wrote it (stage 4, W4).
  const subscriptionIds = [...new Set(rows
    .filter(row => row.account_key != null && row.account_key !== "")
    .map(row => row.subscription_id == null ? null : claudePublicationText(row.subscription_id))
    .filter((value): value is string => value !== null && value !== ""))]
    .sort(compareClaudePublicationText);
  const conflict = rows.some(row => claudePublicationInteger(row.subscription_conflict) !== 0n)
    || accountKeys.length > 1;
  if (winner.account_key == null && accountKeys.length > 0) winner.account_key = accountKeys[0]!;
  if ("subscription_conflict" in winner) winner.subscription_conflict = conflict ? 1 : 0;
  if ("subscription_id" in winner) {
    winner.subscription_id = conflict
      ? null
      : winner.subscription_id ?? subscriptionIds[0] ?? null;
  }
  return winner;
}

/**
 * A Claude call can be present in more than one archive file: a resumed session
 * repeats earlier messages and every profile that is not a desktop export shares
 * the `live` store. The publication delta is file based while the source identity
 * is the call, so each changed file is diffed row by row - an unchanged fact keeps
 * its stored row - and every fact this run does add is then reconciled with a row
 * another file still holds for the same call, before it reaches the unique
 * (store, call_id) index. The more complete reading wins; when the retained row
 * already holds it, nothing is rewritten. Rows are streamed: an archive-wide
 * reread must not be held in JS memory.
 */
/**
 * A changed file's limit refusals replace its earlier ones; unchanged rows keep their rowid. A
 * refusal the store already holds from another file moves to the file read now, as its event does.
 */
function publishClaudeLimitHits(active: Database, staged: Database, identities: DeltaIdentity[]): void {
  const columns = tableColumns(active, "claude_limit_hits").filter(column => column !== "id");
  const fingerprint = (row: Record<string, string>) => JSON.stringify(columns.map(column => row[column]));
  const removed: string[] = [], added: string[] = [];
  for (const identity of identities) {
    const where = identityWhere(DELTA_SPECS.claude, identity);
    const select = `SELECT CAST(rowid AS TEXT) AS __publication_rowid, ${fingerprintColumns(columns)}
      FROM claude_limit_hits WHERE ${where.sql}`;
    const remaining = new Map<string, string[]>();
    for (const row of active.query(select).iterate(...where.params) as Iterable<Record<string, string>>) {
      const rows = remaining.get(fingerprint(row)) ?? [];
      rows.push(row.__publication_rowid!); remaining.set(fingerprint(row), rows);
    }
    for (const row of staged.query(`${select} ORDER BY call_id`).iterate(...where.params) as Iterable<Record<string, string>>) {
      const rows = remaining.get(fingerprint(row));
      if (rows?.length) rows.pop();
      else added.push(row.__publication_rowid!);
    }
    for (const rows of remaining.values()) removed.push(...rows);
  }
  // Refusals are 100% readings of Claude limit windows; the owner is resolved by the producer.
  const changedTimes: number[] = [];
  const timeOf = (db: Database, rowid: string) => Date.parse((db.query("SELECT ts FROM claude_limit_hits WHERE rowid = ?").get(rowid) as { ts: string } | null)?.ts ?? "");
  for (const rowid of removed) changedTimes.push(timeOf(active, rowid));
  for (const rowid of added) changedTimes.push(timeOf(staged, rowid));
  const finite = changedTimes.filter(Number.isFinite);
  if (finite.length) markLimitWindowsDirty(active, "claude", ALL_ACCOUNTS, Math.min(...finite));
  const remove = active.query("DELETE FROM claude_limit_hits WHERE rowid = ?");
  for (const rowid of removed) remove.run(rowid);
  if (added.length === 0) return;
  const read = staged.query("SELECT * FROM claude_limit_hits WHERE rowid = ?");
  const insert = active.query(`INSERT INTO claude_limit_hits (${columns.map(quoteIdentifier).join(",")})
    VALUES (${columns.map(() => "?").join(",")})
    ON CONFLICT(store, call_id) DO UPDATE SET ${columns.filter(column => column !== "store" && column !== "call_id")
      .map(column => `${quoteIdentifier(column)}=excluded.${quoteIdentifier(column)}`).join(",")}`);
  for (const rowid of added) {
    const row = read.get(rowid) as Record<string, SQLQueryBindings> | null;
    if (!row) throw new Error("Staged source row disappeared: claude_limit_hits");
    insert.run(...columns.map(column => row[column] ?? null));
  }
}

export function publishClaudeChangedSourceRows(
  active: Database,
  staged: Database,
  changedIdentities: DeltaIdentity[],
): void {
  const columns = tableColumns(active, "claude_events").filter(column => column !== "id");
  const identities: DeltaIdentity[] = [];
  const seen = new Set<string>();
  for (const identity of changedIdentities) {
    const key = identityKey(DELTA_SPECS.claude, identity);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
  }
  // Deterministic publication: the same sources produce the same rows whichever
  // run reads them, independent of source discovery order.
  identities.sort((left, right) =>
    compareClaudePublicationText(claudePublicationText(left.store), claudePublicationText(right.store))
    || compareClaudePublicationText(claudePublicationText(left.path), claudePublicationText(right.path)));
  const fingerprint = (row: Record<string, string>) => JSON.stringify(columns.map(column => row[column]));
  const removed: string[] = [];
  const added: string[] = [];
  for (const identity of identities) {
    const where = identityWhere(DELTA_SPECS.claude, identity);
    const select = `SELECT CAST(rowid AS TEXT) AS __publication_rowid, ${fingerprintColumns(columns)}
      FROM claude_events WHERE ${where.sql}`;
    const remaining = new Map<string, string[]>();
    for (const row of active.query(select).iterate(...where.params) as Iterable<Record<string, string>>) {
      const key = fingerprint(row), rows = remaining.get(key) ?? [];
      rows.push(row.__publication_rowid!); remaining.set(key, rows);
    }
    for (const row of staged.query(`${select} ORDER BY call_id`).iterate(...where.params) as Iterable<Record<string, string>>) {
      const rows = remaining.get(fingerprint(row));
      if (rows?.length) rows.pop();
      else added.push(row.__publication_rowid!);
    }
    for (const rows of remaining.values()) removed.push(...rows);
  }
  publishClaudeLimitHits(active, staged, identities);
  // Remove the rereadable rows first, across all changed files: a row still
  // present for an added call is then retained evidence from a file this run
  // did not read, never a leftover of this publication.
  const removeRowid = active.query("DELETE FROM claude_events WHERE rowid = ?");
  for (const rowid of removed) removeRowid.run(rowid);
  if (added.length === 0) return;
  const read = staged.query("SELECT * FROM claude_events WHERE rowid = ?");
  const retainedCall = active.query("SELECT * FROM claude_events WHERE store = ? AND call_id = ?");
  const removeCall = active.query("DELETE FROM claude_events WHERE store = ? AND call_id = ?");
  const insert = active.query(
    `INSERT INTO claude_events (${columns.map(quoteIdentifier).join(",")})
     VALUES (${columns.map(() => "?").join(",")})`
  );
  for (const rowid of added) {
    const row = read.get(rowid) as ClaudePublicationRow | null;
    if (!row) throw new Error("Staged source row disappeared: claude_events");
    const store = claudePublicationText(row.store);
    const callId = claudePublicationText(row.call_id);
    const retained = retainedCall.get(store, callId) as ClaudePublicationRow | null;
    if (!retained) {
      insert.run(...columns.map(column => row[column] ?? null));
      continue;
    }
    const merged = mergeClaudePublicationRows([row, retained], columns);
    // The retained reading already carries the merged fact: keep its stored row.
    if (columns.every(column => claudePublicationText(merged[column]) === claudePublicationText(retained[column]))) continue;
    removeCall.run(store, callId);
    insert.run(...columns.map(column => merged[column] ?? null));
  }
}
