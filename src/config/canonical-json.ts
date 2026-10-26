import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type RecordValue = Record<string, unknown>;
export const isRecord = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v);
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : isRecord(v) ?
    Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
export const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
/**
 * `digest({ table: rows.map(canonicalJson).sort() })` for whole tables, hashed piece by piece.
 * Built as one value, 280 000 probe deliveries outgrew a single string and the pre-migration
 * snapshot ran out of memory. The bytes hashed are the same, so stored manifests still match.
 */
export function tablesDigest(db: Database, tables: readonly string[]): string {
  const hash = createHash("sha256");
  [...tables].sort().forEach((table, index) => {
    hash.update(`${index ? "," : "{"}${JSON.stringify(table)}:[`);
    const rows: string[] = [];
    for (const row of db.query(`SELECT * FROM ${table}`).iterate()) rows.push(canonicalJson(row));
    rows.sort();
    for (let at = 0; at < rows.length; at += 1000)
      hash.update((at ? "," : "") + rows.slice(at, at + 1000).map(row => JSON.stringify(row)).join(","));
    hash.update("]");
  });
  return hash.update(tables.length ? "}" : "{}").digest("hex");
}
export const fileDigest = (file: string): string => createHash("sha256").update(fs.existsSync(file) ? fs.readFileSync(file) : "<missing>").digest("hex");
