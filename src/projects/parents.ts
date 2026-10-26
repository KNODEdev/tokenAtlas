import { Buffer } from "node:buffer";
import type { Database } from "../db/sqlite";
import type { ProjectPlace } from "./resolve";

const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const conversationPattern = new RegExp(`(?:^|[-_])(${UUID})\\.jsonl$`, "i");
/** Only the provider's named UUID field is ancestry evidence; never evaluate Python-like nested metadata. */
export function parentThreadId(nested: string | null | undefined): string | null {
  if (!nested?.startsWith("subagent:")) return null;
  const raw = nested.slice("subagent:".length);
  let metadata: unknown;
  try { metadata = JSON.parse(raw); }
  catch { try { metadata = JSON.parse(raw.replace(/'/g, '\"')); } catch { return null; } }
  const parent = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).parent_thread_id : null;
  return typeof parent === "string" && new RegExp(`^${UUID}$`, "i").test(parent) ? parent.toLowerCase() : null;
}
export const contextKey = (source: string, session: string) => JSON.stringify([source.replace(/[A-Z]/g, c => c.toLowerCase()), session.toLowerCase()]);
export interface ParentPlace extends ProjectPlace { source: string | null; nested: string | null }
export interface ParentRow extends ParentPlace { conversation: string | null }

export function parentPlaces(rows: readonly ParentRow[]): Map<string, ParentPlace[]> {
  const bySession = new Map<string, Map<string, ParentPlace>>();
  for (const row of rows) {
    const session = row.conversation && conversationPattern.exec(row.conversation)?.[1];
    if (!row.source || !session) continue;
    const key = contextKey(row.source, session);
    const places = bySession.get(key) ?? new Map();
    const place: ParentPlace = { store: row.store, cwd: row.cwd, project: row.project, repo: row.repo, source: row.source, nested: row.nested };
    places.set(JSON.stringify(place), place); bySession.set(key, places);
  }
  return new Map([...bySession].map(([key, places]) => [key, [...places.values()]]));
}

/** Stored file/hour provenance only: no raw calls, transcript reads, writes or repricing. */
export function readParentPlaces(db: Database, contexts?: readonly { source: string; nested: string }[]): Map<string, ParentPlace[]> {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codex_price_ledger_dims','codex_price_ledger_copies','codex_price_ledger_file_models')").all() as { name: string }[]).map(row => row.name));
  if (tables.size !== 3) return new Map();
  const fields = new Set((db.query("PRAGMA table_info(codex_price_ledger_dims)").all() as { name: string }[]).map(row => row.name));
  if (!["source", "nested", "home", "cwd", "project", "repo"].every(field => fields.has(field))) return new Map();
  // Sources without spawned threads need no parent map. The query runs once per published register revision.
  const sources = contexts ?? db.query("SELECT DISTINCT source FROM codex_price_ledger_dims WHERE nested LIKE 'subagent:%parent_thread_id%' AND source IS NOT NULL").all() as { source: string }[];
  if (!sources.length) return new Map();
  if (contexts) {
    // All stored child references include references made by ancestors, so recursive inheritance keeps its proofs.
    const wanted = new Set(contexts.flatMap(({ source, nested }) => {
      const parent = parentThreadId(nested); return parent ? [contextKey(source, parent)] : [];
    }));
    if (!wanted.size) return new Map();
    const sessions = [...new Set(contexts.map(row => parentThreadId(row.nested)).filter((id): id is string => id !== null))];
    // The UUID precedes the six-character .jsonl suffix; the parser below still validates the full spelling.
    const copies = db.query(`SELECT id,source,conversation FROM codex_price_ledger_copies
      WHERE source IN (SELECT value FROM json_each(?))
        AND lower(substr(conversation,-42,36)) IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...new Set(sources.map(row => row.source))]), JSON.stringify(sessions)) as
      Array<{ id: number; source: string; conversation: string | null }>;
    const ids = copies.filter(row => {
      const session = row.conversation && conversationPattern.exec(row.conversation)?.[1];
      return session && wanted.has(contextKey(row.source, session));
    }).map(row => row.id);
    if (!ids.length) return new Map();
    // Collapse hour evidence before joining wide place metadata; unrelated conversations need no place read.
    return parentPlaces(db.query(`WITH places AS MATERIALIZED (
        SELECT DISTINCT copy_id,dim_id FROM codex_price_ledger_file_models WHERE copy_id IN (SELECT value FROM json_each(?))
      ) SELECT DISTINCT c.source,c.conversation,d.home store,d.cwd,d.project,d.repo,d.nested
        FROM places f JOIN codex_price_ledger_copies c ON c.id=f.copy_id
        JOIN codex_price_ledger_dims d ON d.id=f.dim_id WHERE c.source=d.source`).all(JSON.stringify(ids)) as ParentRow[]);
  }
  return parentPlaces(db.query(`SELECT DISTINCT c.source,c.conversation,d.home store,d.cwd,d.project,d.repo,d.nested
    FROM codex_price_ledger_file_models f JOIN codex_price_ledger_copies c ON c.id=f.copy_id
    JOIN codex_price_ledger_dims d ON d.id=f.dim_id
    WHERE c.source IN (SELECT value FROM json_each(?)) AND c.source=d.source`).all(JSON.stringify(sources.map(row => row.source))) as ParentRow[]);
}

/** A child inherits only a unanimous, resolved parent within its own archived source. */
export function inheritedProject(place: ParentPlace, day: string, parents: ReadonlyMap<string, ParentPlace[]>,
  explicit: (place: ProjectPlace, day: string) => string | null, fallback: (place: ProjectPlace, day: string) => string | null,
  visiting = new Set<string>()): string | null {
  const assigned = explicit(place, day);
  if (assigned !== null) return assigned;
  const parent = parentThreadId(place.nested);
  if (!parent || !place.source) return fallback(place, day);
  const key = contextKey(place.source, parent), candidates = parents.get(key);
  if (!candidates?.length) return fallback(place, day);
  if (visiting.has(key) || visiting.size >= 64) return null;
  const next = new Set(visiting); next.add(key);
  const ids = candidates.map(candidate => inheritedProject(candidate, day, parents, explicit, fallback, next));
  const distinct = new Set(ids);
  return distinct.size === 1 && ids[0] !== null ? ids[0]! : null;
}

export function readParentContexts(db: Database): Array<{ source: string; nested: string }> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_price_ledger_dims'").get()) return [];
  const fields = new Set((db.query("PRAGMA table_info(codex_price_ledger_dims)").all() as { name: string }[]).map(row => row.name));
  if (!fields.has("source") || !fields.has("nested")) return [];
  return db.query("SELECT DISTINCT source,nested FROM codex_price_ledger_dims WHERE nested LIKE 'subagent:%parent_thread_id%' AND source IS NOT NULL").all() as Array<{ source: string; nested: string }>;
}

/** Piecewise-constant inheritance over declared raw-day boundaries, shared by SQLite and JS. */
export function parentContextJson(contexts: Array<{ source: string; nested: string }>, parents: ReadonlyMap<string, ParentPlace[]>,
  boundaries: string[], resolve: (place: ParentPlace, day: string) => string | null): string {
  const days = ["", ...new Set(boundaries)].sort();
  const entries: Record<string, Array<[string, string | null, string | null]>> = {};
  for (const { source, nested } of contexts) {
    const parent = parentThreadId(nested);
    if (!parent || !parents.has(contextKey(source, parent))) continue;
    const hex = (text: string) => Buffer.from(text).toString("hex").toUpperCase();
    const key = `${hex(source.replace(/[A-Z]/g, c => c.toLowerCase()))}_${parent}`;
    if (entries[key]) continue;
    const intervals: Array<[string, string | null, string | null]> = [];
    const place: ParentPlace = { source, nested, store: null, cwd: null, project: null, repo: null };
    days.forEach((from, index) => {
      const id = resolve(place, from || "0000-01-01"), until = days[index + 1] ?? null;
      const previous = intervals.at(-1);
      if (previous && previous[2] === id) previous[1] = until;
      else intervals.push([from, until, id]);
    });
    entries[key] = intervals;
  }
  return JSON.stringify(entries);
}

/** Lookup by source and parent UUID; only the small matching interval array is expanded. */
export function parentContextSql(json: string, source: string, nested: string, day: string, otherwise: string): string {
  if (json === "{}") return otherwise;
  const data = `'${json.replace(/'/g, "''")}'`;
  const raw = `substr(${nested},10)`;
  const legacy = `replace(${raw},char(39),char(34))`;
  const metadata = `(CASE WHEN json_valid(${raw}) THEN ${raw} WHEN json_valid(${legacy}) THEN ${legacy} END)`;
  const parent = `lower(json_extract(${metadata},'$.parent_thread_id'))`;
  const key = `'$.'||hex(lower(${source}))||'_'||${parent}`;
  return `(SELECT CASE WHEN inherited_context IS NULL THEN ${otherwise} ELSE
    (SELECT json_extract(value,'$[2]') FROM json_each(inherited_context)
      WHERE ${day}>=json_extract(value,'$[0]') AND (json_extract(value,'$[1]') IS NULL OR ${day}<json_extract(value,'$[1]')) LIMIT 1)
    END FROM (SELECT json_extract(${data},${key}) inherited_context LIMIT 1))`;
}
