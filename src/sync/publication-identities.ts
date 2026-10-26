import type { DeltaSpec, DeltaIdentity } from "./vendor-publication-schema";
import type { Database, SQLQueryBindings } from "../db/sqlite";
import type { VendorId } from "./contracts";
import { toArchiveLogicalPath } from "../config/paths";
import { DELTA_SPECS, vendorSourceTables, VENDOR_TABLES } from "./vendor-publication-schema";
import { quoteIdentifier, tableExists } from "./sync-sql";

export function identityKey(spec: DeltaSpec, row: Record<string, unknown>): string {
  return JSON.stringify(spec.identity.map((column) => row[column]));
}

export function collectDeltaIdentities(active: Database, stage: Database, vendor: VendorId, selectedFiles?:string[]): DeltaIdentity[] {
  const spec = DELTA_SPECS[vendor];
  const identities = new Map<string, DeltaIdentity>();
  const add = (row: Record<string, unknown>) => {
    const identity = Object.fromEntries(spec.identity.map((column) => [column, row[column]])) as DeltaIdentity;
    identities.set(identityKey(spec, identity), identity);
  };
  for (const table of vendorSourceTables(vendor)) {
    const rows = stage
      .query(
        `SELECT DISTINCT ${spec.identity.map(quoteIdentifier).join(", ")}
           FROM ${quoteIdentifier(table)}`
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) add(row);
  }
  if (spec.bookmarkTable) {
    const columns = [...spec.identity, ...spec.bookmarkCompare];
    const select=`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(spec.bookmarkTable)}`;
    const activeRows:Array<Record<string,unknown>>=[];
    if(selectedFiles) {
      for(let offset=0;offset<selectedFiles.length;offset+=400) {
        const files=selectedFiles.slice(offset,offset+400);
        activeRows.push(...active.query(`${select} WHERE path IN (${files.map(()=>"?").join(",")})`)
          .all(...files.map(toArchiveLogicalPath)) as Array<Record<string,unknown>>);
      }
    } else activeRows.push(...active.query(select).all() as Array<Record<string,unknown>>);
    const before = new Map(activeRows.map((row) => [identityKey(spec, row), row]));
    const stagedRows = stage
      .query(`SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(spec.bookmarkTable)}`)
      .all() as Array<Record<string, unknown>>;
    const after = new Map(stagedRows.map((row) => [identityKey(spec, row), row]));
    for (const row of stagedRows) {
      const previous = before.get(identityKey(spec, row));
      if (!previous || spec.bookmarkCompare.some((column) => previous[column] !== row[column])) add(row);
    }
    for (const row of activeRows) {
      if (!after.has(identityKey(spec, row))) add(row);
    }
  } else {
    const rows = stage
      .query("SELECT key, value FROM meta WHERE key LIKE 'opencode_snapshot:%'")
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const previous = active.query("SELECT value FROM meta WHERE key = ?").get(row.key) as { value: string } | null;
      if (previous?.value !== row.value) add({ store: row.key.slice("opencode_snapshot:".length) });
    }
  }
  return [...identities.values()].sort((a, b) => identityKey(spec, a).localeCompare(identityKey(spec, b)));
}

/**
 * Every identity a first-fill stage holds, in the ordinary publisher's order. The vendor is
 * empty, so unlike {@link collectDeltaIdentities} nothing is compared with stored rows.
 */
export function firstFillIdentities(stage: Database, vendor: VendorId): DeltaIdentity[] {
  const spec = DELTA_SPECS[vendor];
  const identities = new Map<string, DeltaIdentity>();
  const add = (identity: DeltaIdentity) => identities.set(identityKey(spec, identity), identity);
  for (const table of [...vendorSourceTables(vendor), ...(spec.bookmarkTable ? [spec.bookmarkTable] : [])]) {
    if (!tableExists(stage, table)) continue;
    for (const row of stage.query(`SELECT DISTINCT ${spec.identity.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`)
      .iterate() as Iterable<Record<string, string | number>>)
      add(Object.fromEntries(spec.identity.map(column => [column, row[column]!])) as DeltaIdentity);
  }
  if (!spec.bookmarkTable) for (const row of stage.query("SELECT key FROM meta WHERE key LIKE 'opencode_snapshot:%'").all() as Array<{key:string}>)
    add({ store: row.key.slice("opencode_snapshot:".length) });
  return [...identities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, identity]) => identity);
}

export function identityWhere(spec: DeltaSpec, identity: DeltaIdentity): { sql: string; params: SQLQueryBindings[] } {
  return {
    sql: spec.identity.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND "),
    params: spec.identity.map((column) => identity[column] as SQLQueryBindings),
  };
}

export function sourceImpactIdentities(
  active: Database,
  stage: Database,
  vendor: VendorId,
  changedIdentities: DeltaIdentity[],
): DeltaIdentity[] {
  if (vendor !== "claude" || changedIdentities.length === 0) return changedIdentities;
  const spec = DELTA_SPECS.claude;
  const affected = new Map(changedIdentities.map((identity) => [identityKey(spec, identity), identity]));
  const activeOwner = active.query("SELECT store, path FROM claude_events WHERE store = ? AND call_id = ?");
  for (const identity of changedIdentities) {
    const where = identityWhere(spec, identity);
    const stagedCalls = stage
      .query(`SELECT call_id FROM claude_events WHERE ${where.sql}`)
      .all(...where.params) as Array<{ call_id: string }>;
    for (const { call_id } of stagedCalls) {
      const owner = activeOwner.get(String(identity.store), call_id) as DeltaIdentity | null;
      if (owner) affected.set(identityKey(spec, owner), owner);
    }
  }
  return [...affected.values()].sort((a, b) => identityKey(spec, a).localeCompare(identityKey(spec, b)));
}

export function identityTimestampRange(
  sqlite: Database,
  vendor: VendorId,
  identities: DeltaIdentity[]
): { from: string; to: string } | null {
  const spec = DELTA_SPECS[vendor];
  let from: string | null = null;
  let to: string | null = null;
  for (const identity of identities) {
    const where = identityWhere(spec, identity);
    for (const table of VENDOR_TABLES[vendor].data) {
      const row = sqlite
        .query(`SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM ${quoteIdentifier(table)} WHERE ${where.sql}`)
        .get(...where.params) as { from_ts: string | null; to_ts: string | null } | null;
      if (row?.from_ts && (!from || row.from_ts < from)) from = row.from_ts;
      if (row?.to_ts && (!to || row.to_ts > to)) to = row.to_ts;
    }
  }
  return from && to ? { from, to } : null;
}

export function mergeDirtyRanges(
  ...ranges: Array<{ from: string; to: string } | null>
): { from: string; to: string } | null {
  let merged: { from: string; to: string } | null = null;
  for (const range of ranges) {
    if (!range) continue;
    if (!merged) {
      merged = { ...range };
      continue;
    }
    const previousFrom: string = merged.from;
    const previousTo: string = merged.to;
    merged = {
      from: range.from < previousFrom ? range.from : previousFrom,
      to: range.to > previousTo ? range.to : previousTo,
    };
  }
  return merged;
}
