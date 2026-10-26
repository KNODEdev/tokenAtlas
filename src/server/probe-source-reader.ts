import type { Database } from "bun:sqlite";
import { canonicalJson } from "../config/canonical-json";
import { probePayload, validateCanonicalProbe, type CanonicalProbe } from "../db/probe-facts";
import { probePhysicalProfileOf, probeSourceTupleOf, sourceOfProbeTuple, type ProbePhysicalProfile, type ProbeSourceOptions,
  type ProbeSourceRow, type ProbeSourceTuple } from "./probe-source";
import { declaredProbeSource } from "./probe-source-corrections";

export type ProbeSourceResult =
  | { source: string; basis: "canonical" | "projection-only" | "declared-correction" }
  | { source: null; basis: "missing-link" | "stale-link" | "conflicting-link" | "unresolved-source" };

export type IndexedProbeRow = ProbeSourceRow & { id: number } & Record<string, unknown>;

/**
 * What a reading proves about where it was taken, independent of the source declarations: its
 * physical tuples (one per matched canonical fact, or the projection's own on a legacy database)
 * or why it proves nothing. Stored once per reading (`probe_sources`); the archive source follows
 * from it and the declarations of the moment (`resolveProbeEvidence`).
 */
export type ProbeEvidenceBasis = "projection" | "matched" | "missing-link" | "stale-link" | "conflicting-link";
export interface ProbeEvidence { basis: ProbeEvidenceBasis; tuples: Array<ProbeSourceTuple | null>; profiles: ProbePhysicalProfile[] }

/** The archive source of stored evidence under the given declarations and corrections; as `resolve` decides it. */
export function resolveProbeEvidence(provider: string, evidence: Pick<ProbeEvidence, "basis" | "tuples">,
  row: { subject?: string; ts?: string; machine?: string | null }, options: ProbeSourceOptions): ProbeSourceResult {
  if (evidence.basis === "missing-link" || evidence.basis === "stale-link" || evidence.basis === "conflicting-link")
    return { source: null, basis: evidence.basis };
  const sources = new Set<string>();
  let unresolved = false;
  for (const tuple of evidence.tuples) {
    const source = tuple ? sourceOfProbeTuple(provider, tuple, options) : null;
    if (source) sources.add(source); else unresolved = true;
  }
  if (evidence.basis === "projection") {
    const source = sources.values().next().value;
    return source ? { source, basis: "projection-only" } : { source: null, basis: "unresolved-source" };
  }
  // Duplicate deliveries may have distinct fact IDs; only unanimous physical proof is enough.
  if (sources.size > 1) return { source: null, basis: "conflicting-link" };
  if (unresolved) {
    const correction = sources.size === 0 ? declaredProbeSource({ provider, ...row }, options.corrections ?? []) : null;
    return correction ? { source: correction, basis: "declared-correction" } : { source: null, basis: "unresolved-source" };
  }
  return { source: sources.values().next().value!, basis: "canonical" };
}

/**
 * The declaration-independent evidence reader of one database. Each call uses
 * probe_fact_legacy_pointer(namespace,legacy_id), then primary-key fact lookups. Legacy-only
 * databases can still use physical metadata on their projection; a database with canonical facts
 * never guesses from a missing or disputed link.
 */
export function probeEvidenceReader(sqlite: Database): (row: IndexedProbeRow) => ProbeEvidence {
  const tables = new Set((sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
    ('probe_fact_legacy_map','probe_fact_backfill_checkpoints','probe_counters','probe_observations')`)
    .all() as { name: string }[]).map(row => row.name));
  if (tables.size === 0) return row => {
    const profile = probePhysicalProfileOf(row);
    return { basis: "projection", tuples: [probeSourceTupleOf(row)], profiles: profile ? [profile] : [] };
  };
  const none = (basis: ProbeEvidenceBasis): ProbeEvidence => ({ basis, tuples: [], profiles: [] });
  if (tables.size !== 4) return () => none("missing-link");
  const namespace = (sqlite.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'")
    .get() as { namespace: string } | null)?.namespace;
  if (!namespace) return () => none("missing-link");

  const linked = sqlite.query(`SELECT m.counter_id, m.evidence_hash,
      c.observation_id, c.discriminator, c.payload, c.payload_digest, o.header
    FROM probe_fact_legacy_map m
    LEFT JOIN probe_counters c ON c.id=m.counter_id
    LEFT JOIN probe_observations o ON o.id=c.observation_id
    WHERE m.namespace=? AND m.legacy_id=?`);
  type Link = { counter_id: string; evidence_hash: string; observation_id: string | null;
    discriminator: string | null; payload: string | null; payload_digest: string | null; header: string | null };
  return row => {
    if (!Number.isSafeInteger(row.id)) return none("missing-link");
    const links = linked.all(namespace, row.id) as Link[];
    if (!links.length) return none("missing-link");
    let projected: ReturnType<typeof probePayload>;
    try { projected = probePayload({ ...row, raw_subject: null, login: null, source_home: null }, true); }
    catch { return none("stale-link"); }
    const tuples = new Map<string, ProbeSourceTuple | null>();
    const profiles = new Map<string, ProbePhysicalProfile>();
    let matched = false;
    for (const link of links) {
      if (!link.observation_id || !link.discriminator || !link.payload || !link.payload_digest || !link.header
        || link.evidence_hash !== link.payload_digest) return none("conflicting-link");
      let fact: CanonicalProbe;
      try {
        fact = validateCanonicalProbe({ version: 1, observation_id: link.observation_id,
          counter_id: link.counter_id, header: JSON.parse(link.header),
          discriminator: JSON.parse(link.discriminator), payload: JSON.parse(link.payload),
          payload_digest: link.payload_digest });
      } catch { return none("conflicting-link"); }
      const restored = { ...projected, subject: fact.payload.subject,
        raw_subject: fact.payload.raw_subject, login: fact.payload.login,
        source_home: fact.payload.source_home };
      if (canonicalJson(restored) !== canonicalJson(fact.payload)) continue;
      matched = true;
      const physical = { ...fact.payload, provider: fact.header.provider };
      const tuple = probeSourceTupleOf(physical), profile = probePhysicalProfileOf(physical);
      tuples.set(JSON.stringify(tuple && [tuple.machine.toLowerCase(), tuple.home.toLowerCase(), tuple.login.toLowerCase()]), tuple);
      if (profile) profiles.set(JSON.stringify([profile.machine.toLowerCase(), profile.home.toLowerCase(), profile.login.toLowerCase()]), profile);
    }
    if (!matched) return none("stale-link");
    return { basis: "matched", tuples: [...tuples.values()], profiles: [...profiles.values()] };
  };
}
