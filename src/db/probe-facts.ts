import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { canonicalJson, digest, tablesDigest } from "../config/canonical-json";

export const PROBE_FACT_TABLES = ["probe_observations", "probe_counters", "probe_fact_deliveries", "probe_fact_legacy_map", "probe_fact_conflicts", "probe_fact_backfill_checkpoints"] as const;
const strings = ["plan", "limit_group", "scope", "resets_at", "profile", "error", "extra", "machine", "login", "source_home", "raw_subject"] as const;
const numbers = ["used_percent", "remaining_percent", "vendor_percent", "window_minutes", "allowance", "used", "remaining", "rate_limit_reached", "reset_credits", "ok"] as const;
const required = ["provider", "subject", "ts", "kind", "reported_percent_side"] as const;
export const PROBE_PAYLOAD_KEYS: readonly string[] = [...required, ...strings, ...numbers];
export type ProbePayload =Record<string, string | number | null>;
export interface ProbeHeader {
  provider: string; subject: string; ts: string; recorded_at: string;
  machine: string | null; login: string | null; original_subject: "recorded" | "unknown";
  origin: { machine_id: string; runtime_id: string; source_id: string | null; declaration_digest: string; config_version: number } | null;
}
export interface CanonicalProbe {
  version: 1; observation_id: string; counter_id: string; header: ProbeHeader;
  discriminator: unknown[]; payload: ProbePayload; payload_digest: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function hasProbeFacts(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE name='probe_observations'").get() != null;
}
/** Only the exact built-in immutable guards are safe for empty-target bulk inserts. */
export function hasCustomProbeTriggers(db:Database,tables:readonly string[]):boolean {
  const normalize=(sql:string)=>sql.replace(/\s+/g," ").trim().replace(/;$/,"");
  const known=new Set<string>();
  // The evidence queue's link triggers only record which readings to look at again (`probe-sources.ts`).
  const evidenceQueue=/^CREATE TRIGGER probe_sources_link_after_(insert|update|delete) AFTER (INSERT|UPDATE|DELETE) ON probe_fact_legacy_map( WHEN (NEW|OLD)\.legacy_id IS NOT NULL)? BEGIN( INSERT OR IGNORE INTO probe_source_dirty\(probe_id\) (VALUES \((NEW|OLD)\.legacy_id\)|SELECT (NEW|OLD)\.legacy_id WHERE (NEW|OLD)\.legacy_id IS NOT NULL);)+ END$/;
  for(const [table,label] of [["probe_observations","observation"],["probe_counters","counter"]]){
    for(const operation of ["UPDATE","DELETE"])
      known.add(normalize(`CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Immutable probe ${label}'); END`));
    known.add(normalize(`CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'Immutable probe ${label}'); END`));
  }
  return (db.query("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger'").all() as Array<{tbl_name:string;sql:string}>)
    .some(row=>tables.includes(row.tbl_name)&&!known.has(normalize(row.sql))&&!evidenceQueue.test(normalize(row.sql)));
}
export function probePayload(value: Record<string, unknown>, strict = false): ProbePayload {
  const out: ProbePayload = {};
  for (const key of required) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error("Invalid canonical probe payload");
    out[key] = value[key];
  }
  for (const key of strings) {
    if (strict && value[key] !== null && typeof value[key] !== "string") throw new Error("Invalid canonical probe string");
    out[key] = typeof value[key] === "string" ? value[key] : null;
  }
  for (const key of numbers) {
    if (strict && value[key] !== null && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new Error("Invalid canonical probe number");
    out[key] = typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
  }
  return out;
}
function dimensions(p: ProbePayload): unknown[] { return ["probe-counter-v1", p.provider, p.kind, p.limit_group, p.scope, p.window_minutes]; }
/** Legacy rows carry no origin; another counter with these dimensions at the same time is ambiguous. */
export function sameProbeDimensions(prior: ProbePayload, payload: ProbePayload): boolean {
  return canonicalJson(dimensions(prior)) === canonicalJson(dimensions(payload));
}
function counterId(id: string, discriminator: unknown[]): string { return `pc1:${digest([id, discriminator])}`; }
export function createProbeCollection(rows: Record<string, unknown>[], legacy = false): CanonicalProbe[] {
  if (!rows.length) return [];
  const observation_id = randomUUID();
  const first = probePayload(rows[0]!);
  const header: ProbeHeader = { provider: String(first.provider), subject: String(first.subject), ts: String(first.ts),
    recorded_at: new Date().toISOString(), machine: first.machine as string | null, login: first.login as string | null,
    // `origin` stays in the fact format (it is part of stored and journaled facts); nothing declares a source mapping any more.
    original_subject: legacy ? "unknown" : "recorded", origin: null };
  const occurrences = new Map<string, number>();
  return rows.map(row => {
    const payload = probePayload(row), d = dimensions(payload), key = canonicalJson(d);
    const n = occurrences.get(key) ?? 0; occurrences.set(key, n + 1);
    const discriminator = [...d, n];
    return { version: 1, observation_id, counter_id: counterId(observation_id, discriminator), header, discriminator, payload, payload_digest: digest(payload) };
  });
}
/**
 * Rebuild a canonical probe from the parts a compact journal line carries. Everything else in
 * the envelope is a function of them, so a line need not repeat it.
 */
export function assembleCanonicalProbe(observation_id: string, occurrence: number, payload: ProbePayload,
  envelope: Pick<ProbeHeader, "recorded_at" | "original_subject" | "origin">): CanonicalProbe {
  const discriminator = [...dimensions(payload), occurrence];
  const header: ProbeHeader = { provider: String(payload.provider), subject: String(payload.subject), ts: String(payload.ts),
    recorded_at: envelope.recorded_at, machine: payload.machine as string | null, login: payload.login as string | null,
    original_subject: envelope.original_subject, origin: envelope.origin };
  return { version: 1, observation_id, counter_id: counterId(observation_id, discriminator), header, discriminator, payload,
    payload_digest: digest(payload) };
}
export function validateCanonicalProbe(value: unknown, outer?: Record<string, unknown>): CanonicalProbe {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > 64 * 1024) throw new Error("Canonical probe exceeds 64 KiB");
  if (!record(value) || value.version !== 1 || typeof value.observation_id !== "string" || !uuid.test(value.observation_id)
      || !record(value.header) || !record(value.payload) || !Array.isArray(value.discriminator)) throw new Error("Invalid canonical probe envelope");
  const c = value as unknown as CanonicalProbe, h = c.header;
  const p = probePayload(c.payload, true), d = c.discriminator;
  if (canonicalJson(p) !== canonicalJson(c.payload) || d.length !== 7 || !Number.isSafeInteger(d[6]) || Number(d[6]) < 0
      || canonicalJson(d.slice(0, 6)) !== canonicalJson(dimensions(p)) || c.counter_id !== counterId(c.observation_id, d)
      || c.payload_digest !== digest(p) || h.provider !== p.provider || h.subject !== p.subject || h.ts !== p.ts
      || h.machine !== p.machine || h.login !== p.login || !Number.isFinite(Date.parse(h.recorded_at))
      || !["recorded", "unknown"].includes(h.original_subject)) throw new Error("Canonical probe integrity mismatch");
  if (h.origin !== null && (!record(h.origin) || typeof h.origin.machine_id !== "string" || typeof h.origin.runtime_id !== "string"
      || (h.origin.source_id !== null && typeof h.origin.source_id !== "string") || !/^[a-f0-9]{64}$/.test(h.origin.declaration_digest)
      || !Number.isSafeInteger(h.origin.config_version))) throw new Error("Invalid canonical probe origin");
  if (outer && canonicalJson(probePayload(outer, true)) !== canonicalJson(p)) throw new Error("Canonical probe outer payload mismatch");
  return c;
}
export class ProbeFactConflict extends Error {
  constructor(public family: string, public prior: string, public candidate: string, reason: string) { super(reason); }
}
export function quarantineProbeConflict(db: Database, error: unknown): void {
  if (!(error instanceof ProbeFactConflict) || !hasProbeFacts(db)) return;
  const bounded = (value: string) => Buffer.byteLength(value, "utf8") <= 64 * 1024 ? value
    : canonicalJson({ evidence_digest: digest(value), bytes: Buffer.byteLength(value, "utf8"), retained_in: "source-journal-or-existing-fact" });
  const prior = bounded(error.prior), candidate = bounded(error.candidate);
  db.query("INSERT OR IGNORE INTO probe_fact_conflicts VALUES (?,?,?,?,?)").run(digest([error.family, error.message, prior, candidate]), error.family, error.message, prior, candidate);
}
export function retainProbeConflicts(active: Database, stage: Database): void {
  if (!hasProbeFacts(stage) || !hasProbeFacts(active)) return;
  active.transaction(() => {
    for (const row of stage.query("SELECT * FROM probe_fact_conflicts").iterate() as Iterable<{ id: string; family: string; reason: string; existing_payload: string; candidate_payload: string }>) {
      if (row.id !== digest([row.family, row.reason, row.existing_payload, row.candidate_payload])) throw new Error("Invalid staged probe conflict evidence");
      quarantineProbeConflict(active, new ProbeFactConflict(row.family, row.existing_payload, row.candidate_payload, row.reason));
    }
  }).immediate();
}
export function acceptProbeFact(db: Database, c: CanonicalProbe): boolean {
  if (!db.inTransaction) throw new Error("Canonical probe requires fact transaction");
  validateCanonicalProbe(c);
  const header = canonicalJson(c.header), payload = canonicalJson(c.payload), discriminator = canonicalJson(c.discriminator);
  const prior = db.query("SELECT header FROM probe_observations WHERE id=?").get(c.observation_id) as { header: string } | null;
  if (prior && prior.header !== header) throw new ProbeFactConflict(c.header.provider, prior.header, canonicalJson(c), "observation-header-conflict");
  const old = db.query("SELECT * FROM probe_counters WHERE id=?").get(c.counter_id) as { payload: string; observation_id: string; discriminator: string; payload_digest: string } | null;
  if (old && (old.payload !== payload || old.observation_id !== c.observation_id || old.discriminator !== discriminator || old.payload_digest !== c.payload_digest)) {
    throw new ProbeFactConflict(c.header.provider, canonicalJson(old), canonicalJson(c), "counter-identity-conflict");
  }
  if (!prior) db.query("INSERT INTO probe_observations VALUES (?,?)").run(c.observation_id, header);
  if (old) return false;
  db.query("INSERT INTO probe_counters VALUES (?,?,?,?,?)").run(c.counter_id, c.observation_id, discriminator, payload, c.payload_digest);
  return true;
}
/** Whether this producer's delivery of a counter under a journal entry id is committed. */
export function hasProducerDelivery(db: Database, counterId: string, entryId: string): boolean {
  return db.query("SELECT 1 FROM probe_fact_deliveries WHERE id=?").get(digest([counterId, entryId, "producer", null])) != null;
}
export function recordProbeDelivery(db: Database, c: CanonicalProbe, key: string, evidence: Record<string, unknown>): void {
  const id = digest([c.counter_id, key, evidence.role ?? null, evidence.received_by ?? null]);
  db.query("INSERT OR IGNORE INTO probe_fact_deliveries VALUES (?,?,?)").run(id, c.counter_id, canonicalJson(evidence));
}
function namespace(db: Database): string {
  let row = db.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'").get() as { namespace: string } | null;
  if (!row) {
    db.query("INSERT INTO probe_fact_backfill_checkpoints VALUES ('local',?,0,?)").run(randomUUID(), digest([]));
    row = db.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'").get() as { namespace: string };
  }
  return row.namespace;
}
export function mapProbeLegacy(db: Database, c: CanonicalProbe, legacyId: number | null, reason: string, evidenceKey = ""): void {
  const ns = namespace(db), hash = digest(c.payload);
  const id = digest([ns, legacyId, hash, c.counter_id, evidenceKey]);
  db.query("INSERT OR IGNORE INTO probe_fact_legacy_map VALUES (?,?,?,?,?,?)").run(id, ns, legacyId, hash, c.counter_id, reason);
}

export function hasHandledProbeProjection(db: Database, c: CanonicalProbe): boolean {
  const checkpoint = db.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'").get() as { namespace: string } | null;
  if (!checkpoint) return false;
  const mappings = db.query("SELECT legacy_id,evidence_hash,reason FROM probe_fact_legacy_map WHERE namespace=? AND counter_id=?")
    .all(checkpoint.namespace, c.counter_id) as { legacy_id: number | null; evidence_hash: string; reason: string }[];
  for (const mapping of mappings) {
    if (mapping.evidence_hash !== c.payload_digest) {
      throw new ProbeFactConflict(c.header.provider, canonicalJson(mapping), canonicalJson(c), "probe-projection-evidence-conflict");
    }
    if (mapping.legacy_id === null) {
      if (["legacy-multiplicity-suppressed", "bound-projection-collision"].includes(mapping.reason)) return true;
      continue;
    }
    const row = db.query("SELECT * FROM probe_windows WHERE id=?").get(mapping.legacy_id) as Record<string, unknown> | null;
    if (!row) continue;
    const projected = probePayload(row);
    const measured = {
      ...projected,
      subject: c.payload.subject,
      raw_subject: c.payload.raw_subject,
      login: c.payload.login,
      source_home: c.payload.source_home,
    };
    if (canonicalJson(measured) === canonicalJson(c.payload)) return true;
  }
  return false;
}
export function legacyJournalProbe(db: Database, row: Record<string, unknown>, evidenceKey: string): CanonicalProbe {
  const id = digest(["legacy-journal", evidenceKey]);
  const old = db.query("SELECT c.*,o.header FROM probe_fact_legacy_map m JOIN probe_counters c ON c.id=m.counter_id JOIN probe_observations o ON o.id=c.observation_id WHERE m.id=?").get(id) as { id: string; observation_id: string; header: string; discriminator: string; payload: string; payload_digest: string } | null;
  if (old) return { version: 1, observation_id: old.observation_id, counter_id: old.id, header: JSON.parse(old.header), discriminator: JSON.parse(old.discriminator), payload: JSON.parse(old.payload), payload_digest: old.payload_digest };
  const c = createProbeCollection([row], true)[0]!;
  acceptProbeFact(db, c);
  recordLegacyAmbiguity(db, c);
  db.query("INSERT INTO probe_fact_legacy_map VALUES (?,?,NULL,?,?,?)").run(id, namespace(db), digest(c.payload), c.counter_id, "legacy-journal-unresolved-origin");
  return c;
}
function recordLegacyAmbiguity(db: Database, c: CanonicalProbe): void {
  const rows = db.query("SELECT id,payload FROM probe_counters WHERE id<>? AND json_extract(payload,'$.provider')=? AND json_extract(payload,'$.ts')=?").iterate(c.counter_id, c.payload.provider!, c.payload.ts!) as Iterable<{ id: string; payload: string }>;
  for (const row of rows) {
    if (sameProbeDimensions(JSON.parse(row.payload) as ProbePayload, c.payload)) {
      quarantineProbeConflict(db, new ProbeFactConflict(c.header.provider, row.payload, canonicalJson(c), "legacy-equivalence-unresolved"));
    }
  }
}
export function backfillProbeFacts(db: Database, options: { rescan?: boolean; afterBatch?: () => void; batchSize?: number } = {}): void {
  if (!hasProbeFacts(db)) return;
  // Replay looks up one counter at a time; avoid a scan of all historical mappings per record.
  db.exec("CREATE INDEX IF NOT EXISTS probe_fact_counter_mapping ON probe_fact_legacy_map(counter_id,namespace,legacy_id)");
  const size = options.batchSize ?? 128;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw new Error("Invalid probe backfill batch");
  db.transaction(() => namespace(db)).immediate();
  const cp = db.query("SELECT * FROM probe_fact_backfill_checkpoints WHERE id='local'").get() as { namespace: string; cursor: number };
  let cursor = options.rescan ? 0 : cp.cursor;
  for (;;) {
    const rows = db.query("SELECT * FROM probe_windows WHERE id>? ORDER BY id LIMIT ?").all(cursor, size) as (Record<string, unknown> & { id: number })[];
    if (!rows.length) break;
    db.transaction(() => {
      for (const row of rows) {
        const mapped = db.query("SELECT * FROM probe_fact_legacy_map WHERE namespace=? AND legacy_id=?").all(cp.namespace, row.id) as { counter_id: string; evidence_hash: string }[];
        // Attribution changes do not alter the captured payload or create a new fact.
        const matches = mapped.some(m => {
          const old = db.query("SELECT payload FROM probe_counters WHERE id=?").get(m.counter_id) as { payload: string };
          const raw = JSON.parse(old.payload) as ProbePayload;
          return canonicalJson({ ...probePayload(row), subject: raw.subject, raw_subject: raw.raw_subject, login: raw.login, source_home: raw.source_home }) === canonicalJson(raw);
        });
        if (matches) continue;
        const c = createProbeCollection([row], true)[0]!;
        acceptProbeFact(db, c); mapProbeLegacy(db, c, row.id, "legacy-unresolved-origin");
        recordLegacyAmbiguity(db, c);
        recordProbeDelivery(db, c, `legacy:${cp.namespace}:${row.id}`, { row: canonicalJson(row), namespace: cp.namespace, rowid: row.id });
        if (mapped.length) quarantineProbeConflict(db, new ProbeFactConflict(c.header.provider, canonicalJson(mapped), canonicalJson(c), "legacy-pointer-changed"));
      }
      cursor = rows.at(-1)!.id;
      db.query("UPDATE probe_fact_backfill_checkpoints SET cursor=max(cursor,?), evidence_hash=? WHERE id='local'").run(cursor, digest(rows));
    }).immediate();
    options.afterBatch?.();
  }
}
export interface ProbeShadow { family: string; canonical: number; represented: number; conflicts: number; cutover: "blocked" | "compatible" }
export function probeFactShadow(db: Database): ProbeShadow[] {
  if (!hasProbeFacts(db)) return [];
  const out = new Map<string, ProbeShadow>();
  // Subject may be restamped; these three provenance fields do not exist in the legacy projection.
  const projectionKey = (p: ProbePayload) => canonicalJson({ ...p, subject: null, raw_subject: null, login: null, source_home: null });
  const available = new Map<string, number>();
  for (const row of db.query("SELECT * FROM probe_windows").all() as Record<string, unknown>[]) {
    const key = projectionKey(probePayload(row)); available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const row of db.query("SELECT id,payload FROM probe_counters").all() as { id: string; payload: string }[]) {
    const p = JSON.parse(row.payload) as ProbePayload, family = String(p.provider);
    const item = out.get(family) ?? { family, canonical: 0, represented: 0, conflicts: 0, cutover: "compatible" as const };
    item.canonical++;
    const key = projectionKey(p), remaining = available.get(key) ?? 0;
    if (remaining > 0) { item.represented++; available.set(key, remaining - 1); }
    out.set(family, item);
  }
  for (const item of out.values()) {
    item.conflicts = (db.query("SELECT count(*) AS n FROM probe_fact_conflicts WHERE family=? OR family='unknown'").get(item.family) as { n: number }).n;
    const legacy = (db.query("SELECT count(*) AS n FROM probe_windows WHERE provider=?").get(item.family) as { n: number }).n;
    if (item.conflicts || item.represented !== item.canonical || item.canonical !== legacy) item.cutover = "blocked";
  }
  return [...out.values()].sort((a, b) => a.family.localeCompare(b.family));
}
export function probeFactsDigest(db: Database): string {
  return tablesDigest(db, PROBE_FACT_TABLES);
}
export function linkPublishedProbeFacts(db: Database, replayedOnly = false, bulk = false): void {
  if (!hasProbeFacts(db)) return;
  const source = replayedOnly
    ? "sync_stage.gauge_replay_counters r CROSS JOIN probe_counters c ON c.id=r.counter_id"
    : "probe_counters c";
  if(bulk && !hasCustomProbeTriggers(db,["probe_fact_legacy_map"])){
    const ns=namespace(db),columns=new Set((db.query("PRAGMA table_info(probe_windows)").all() as Array<{name:string}>).map(c=>c.name));
    const ignored=new Set(["subject","raw_subject","login","source_home"]);
    const conditions=PROBE_PAYLOAD_KEYS.filter(key=>!ignored.has(key)).map(key=>{
      const value=!columns.has(key)?"NULL":numbers.includes(key as typeof numbers[number])
        ?`CASE WHEN typeof(w."${key}") IN ('integer','real') THEN w."${key}" END`
        :`CASE WHEN typeof(w."${key}")='text' THEN w."${key}" END`;
      return `${value} IS json_extract(c.payload,'$.${key}')`;
    }).join(" AND ");
    let rows:Array<[string,string,number,string,string,string]>=[];
    const flush=()=>{if(!rows.length)return;db.query(`INSERT OR IGNORE INTO probe_fact_legacy_map VALUES ${rows.map(()=>"(?,?,?,?,?,?)").join(",")}`).run(...rows.flat());rows=[];};
    for(const row of db.query(`SELECT c.id,c.payload_digest,w.id AS legacy_id FROM ${source}
      JOIN probe_windows w ON w.provider=json_extract(c.payload,'$.provider') AND w.ts=json_extract(c.payload,'$.ts')
        AND w.kind=json_extract(c.payload,'$.kind') WHERE ${conditions}`).iterate() as Iterable<{id:string;payload_digest:string;legacy_id:number}>){
      rows.push([digest([ns,row.legacy_id,row.payload_digest,row.id,""]),ns,row.legacy_id,row.payload_digest,row.id,"published-projection"]);if(rows.length===100)flush();
    }
    flush();
    if(!replayedOnly)db.query("UPDATE probe_fact_backfill_checkpoints SET cursor=max(cursor,coalesce((SELECT max(id) FROM probe_windows),0)) WHERE id='local'").run();
    return;
  }
  for (const row of db.query(`SELECT c.*,o.header FROM ${source} JOIN probe_observations o ON o.id=c.observation_id`).all() as { id: string; observation_id: string; header: string; discriminator: string; payload: string; payload_digest: string }[]) {
    const p = JSON.parse(row.payload) as ProbePayload;
    const candidates = db.query("SELECT * FROM probe_windows WHERE provider=? AND ts=? AND kind=?").all(p.provider!, p.ts!, p.kind!) as (Record<string, unknown> & { id: number })[];
    for (const r of candidates) if (canonicalJson({ ...probePayload(r), subject: p.subject, raw_subject: p.raw_subject, login: p.login, source_home: p.source_home }) === canonicalJson(p)) {
      mapProbeLegacy(db, { version: 1, observation_id: row.observation_id, counter_id: row.id, header: JSON.parse(row.header), discriminator: JSON.parse(row.discriminator), payload: p, payload_digest: row.payload_digest }, r.id, "published-projection");
    }
  }
  if (!replayedOnly) db.query("UPDATE probe_fact_backfill_checkpoints SET cursor=max(cursor,coalesce((SELECT max(id) FROM probe_windows),0)) WHERE id='local'").run();
}
/**
 * A first fill links every published row to its fact. When no row after the cursor lacks a link,
 * the next backfill would only recheck each row (about 4 s per 100,000), so the cursor moves past them.
 */
export function advanceLinkedProbeBackfill(db: Database): void {
  if (!hasProbeFacts(db)) return;
  db.query(`UPDATE probe_fact_backfill_checkpoints SET cursor=max(cursor,coalesce((SELECT max(id) FROM probe_windows),0))
    WHERE id='local' AND NOT EXISTS (SELECT 1 FROM probe_windows w WHERE w.id>cursor
      AND NOT EXISTS (SELECT 1 FROM probe_fact_legacy_map m WHERE m.namespace=? AND m.legacy_id=w.id))`).run(namespace(db));
}
export function validateProbeFacts(db: Database): void {
  for (const t of PROBE_FACT_TABLES) db.query(`SELECT * FROM ${t} LIMIT 0`).all();
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Probe facts foreign key mismatch");
  for (const row of db.query("SELECT id,header FROM probe_observations").all() as { id: string; header: string }[]) {
    if (!uuid.test(row.id) || !record(JSON.parse(row.header)) || !db.query("SELECT 1 FROM probe_counters WHERE observation_id=?").get(row.id)) throw new Error("Invalid probe observation header");
  }
  for (const row of db.query("SELECT m.evidence_hash,c.payload_digest FROM probe_fact_legacy_map m JOIN probe_counters c ON c.id=m.counter_id").all() as { evidence_hash: string; payload_digest: string }[]) {
    if (row.evidence_hash !== row.payload_digest) throw new Error("Probe mapping evidence mismatch");
  }
  for (const row of db.query("SELECT * FROM probe_fact_backfill_checkpoints").all() as { namespace: string; cursor: number; evidence_hash: string }[]) {
    if (!uuid.test(row.namespace) || !Number.isSafeInteger(row.cursor) || row.cursor < 0 || !/^[a-f0-9]{64}$/.test(row.evidence_hash)) throw new Error("Invalid probe backfill checkpoint");
  }
  for (const row of db.query("SELECT * FROM probe_fact_conflicts").all() as { id: string; family: string; reason: string; existing_payload: string; candidate_payload: string }[]) {
    if (row.id !== digest([row.family, row.reason, row.existing_payload, row.candidate_payload])) throw new Error("Probe conflict evidence mismatch");
  }
  for (const row of db.query("SELECT c.*,o.header FROM probe_counters c LEFT JOIN probe_observations o ON o.id=c.observation_id").all() as { id: string; observation_id: string; header: string; discriminator: string; payload: string; payload_digest: string }[]) {
    validateCanonicalProbe({ version: 1, observation_id: row.observation_id, counter_id: row.id, header: JSON.parse(row.header), discriminator: JSON.parse(row.discriminator), payload: JSON.parse(row.payload), payload_digest: row.payload_digest });
  }
}
export interface ProbePublicationRange { from: string | null; untilExclusive: string | null }
export function mergeProbeFacts(db: Database, range?: ProbePublicationRange, replayedOnly = false): number {
  if (!hasProbeFacts(db)) return 0;
  const stageNamespace = (db.query("SELECT namespace FROM sync_stage.probe_fact_backfill_checkpoints WHERE id='local'")
    .get() as {namespace:string}|null)?.namespace;
  const predicates = range
    ? ["(? IS NULL OR julianday(json_extract(c.payload,'$.ts')) >= julianday(?))", "(? IS NULL OR julianday(json_extract(c.payload,'$.ts')) < julianday(?))"]
    : [];
  if (replayedOnly) predicates.push("EXISTS (SELECT 1 FROM sync_stage.gauge_replay_counters r WHERE r.counter_id=c.id)");
  const selection = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const parameters = range ? [range.from, range.from, range.untilExclusive, range.untilExclusive] : [];
  const empty = ["probe_observations","probe_counters","probe_fact_deliveries","probe_fact_legacy_map","probe_fact_conflicts"].every(table=>!db.query(`SELECT 1 FROM ${table} LIMIT 1`).get())
    && !hasCustomProbeTriggers(db,["probe_observations","probe_counters","probe_fact_deliveries","probe_fact_legacy_map","probe_fact_conflicts"]);
  if(empty){
    if(!db.inTransaction)throw new Error("Canonical probe requires fact transaction");
    // The original acceptance validates every selected fact; SQL then copies the verified rows once.
    for(const row of db.query(`SELECT c.*,o.header FROM sync_stage.probe_counters c JOIN sync_stage.probe_observations o ON o.id=c.observation_id ${selection}`).iterate(...parameters) as Iterable<{id:string;observation_id:string;header:string;discriminator:string;payload:string;payload_digest:string}>)
      validateCanonicalProbe({version:1,observation_id:row.observation_id,counter_id:row.id,header:JSON.parse(row.header),discriminator:JSON.parse(row.discriminator),payload:JSON.parse(row.payload),payload_digest:row.payload_digest});
    db.query(`INSERT INTO probe_observations SELECT DISTINCT o.* FROM sync_stage.probe_counters c JOIN sync_stage.probe_observations o ON o.id=c.observation_id ${selection}`).run(...parameters);
    const result=db.query(`INSERT INTO probe_counters SELECT c.* FROM sync_stage.probe_counters c ${selection}`).run(...parameters);
    for(const table of ["probe_fact_deliveries","probe_fact_legacy_map","probe_fact_conflicts"] as const){
      if(replayedOnly && table==="probe_fact_conflicts")continue;
      const filtered=(range||replayedOnly)&&table!=="probe_fact_conflicts";
      const source=filtered?`sync_stage.${table} e JOIN sync_stage.probe_counters c ON c.id=e.counter_id ${selection}`:`sync_stage.${table} e`;
      const exclusions=table==="probe_fact_legacy_map"?`e.namespace IS NOT ? OR e.legacy_id IS NULL`:undefined;
      db.query(`INSERT INTO ${table} SELECT e.* FROM ${source}${exclusions?`${filtered&&selection?" AND":" WHERE"} (${exclusions})`:""}`)
        .run(...(filtered?parameters:[]),...(exclusions?[stageNamespace??null]:[]));
    }
    return result.changes;
  }
  let inserted = 0;
  for (const row of db.query(`SELECT c.*,o.header FROM sync_stage.probe_counters c JOIN sync_stage.probe_observations o ON o.id=c.observation_id ${selection}`).iterate(...parameters) as Iterable<{ id: string; observation_id: string; header: string; discriminator: string; payload: string; payload_digest: string }>) {
    if (acceptProbeFact(db, { version: 1, observation_id: row.observation_id, counter_id: row.id, header: JSON.parse(row.header), discriminator: JSON.parse(row.discriminator), payload: JSON.parse(row.payload), payload_digest: row.payload_digest })) inserted++;
  }
  for (const table of ["probe_fact_deliveries", "probe_fact_legacy_map", "probe_fact_conflicts"] as const) {
    if (replayedOnly && table === "probe_fact_conflicts") continue;
    const filtered = (range || replayedOnly) && table !== "probe_fact_conflicts";
    const query = filtered
      ? `SELECT e.* FROM sync_stage.${table} e JOIN sync_stage.probe_counters c ON c.id=e.counter_id ${selection}`
      : `SELECT * FROM sync_stage.${table}`;
    for (const row of db.query(query).iterate(...(filtered ? parameters : [])) as Iterable<Record<string, string | number | null>>) {
      const prior = db.query(`SELECT * FROM ${table} WHERE id=?`).get(row.id!) as Record<string, unknown> | null;
      if (prior && canonicalJson(prior) !== canonicalJson(row)) throw new ProbeFactConflict("unknown", canonicalJson(prior), canonicalJson(row), "probe-evidence-conflict");
      // Stage row IDs do not identify live rows. Publication links the actual live projection below.
      if (table === "probe_fact_legacy_map" && !prior && row.namespace === stageNamespace && row.legacy_id !== null) continue;
      const keys = Object.keys(row);
      db.query(`INSERT OR IGNORE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]!));
    }
  }
  return inserted;
}
