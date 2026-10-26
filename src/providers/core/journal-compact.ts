import { canonicalJson } from "../../config/canonical-json";
import { assembleCanonicalProbe, PROBE_PAYLOAD_KEYS, probePayload, type CanonicalProbe, type ProbeHeader, type ProbePayload } from "../../db/probe-facts";

/**
 * Version 3 of a probe journal line. Version 2 wrote every field three times (flat, canonical
 * payload, header) plus identifiers derivable from them, about 3.3 KB per reading for roughly
 * 100 bytes of numbers, and most readings repeat the previous one. A version 3 line carries one
 * set of non-null fields (`p`), or, when the same counter was already written today, a reference
 * to that entry (`b`) with only what differs (`t`, `c`, `x`). Both expand to exactly the
 * canonical probe the producer accepted, so receivers hold the same dense facts as before; the
 * digest prefix `d` proves the expansion.
 */
export const COMPACT_JOURNAL_VERSION = 3;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Origin = ProbeHeader["origin"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DIGEST_PREFIX = 16;

/** Keys of `extra` that differ, when the rest of that JSON text can be taken from the base verbatim. */
function extraPatch(base: string | number | null, next: string | number | null): Record<string, unknown> | null {
  if (typeof base !== "string" || typeof next !== "string") return null;
  let from: unknown, to: unknown;
  try { from = JSON.parse(base); to = JSON.parse(next); } catch { return null; }
  if (!isRecord(from) || !isRecord(to)) return null;
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(to)) {
    if (!(key in from)) return null;
    if (canonicalJson(from[key]) !== canonicalJson(to[key])) patch[key] = to[key];
  }
  // Only a patch that reproduces the producer's exact text may stand in for it.
  return JSON.stringify({ ...from, ...patch }) === next ? patch : null;
}

/** One journal line for an accepted probe; `base` is the same counter's entry written earlier today, if any. */
export function compactProbeLine(entryId: string, fact: CanonicalProbe, base: CanonicalProbe | null): { line: string; full: boolean } {
  const occurrence = Number(fact.discriminator[6]);
  const envelope = { journal_version: COMPACT_JOURNAL_VERSION, journal_entry_id: entryId, o: fact.observation_id, n: occurrence,
    r: fact.header.recorded_at, d: fact.payload_digest.slice(0, DIGEST_PREFIX),
    ...(fact.header.original_subject === "unknown" ? { s: "unknown" } : {}) };
  const fields: ProbePayload = {};
  for (const [key, value] of Object.entries(fact.payload)) {
    if (key === "raw_subject" ? value !== fact.payload.subject : value !== null) fields[key] = value;
  }
  const full = JSON.stringify({ ...envelope, g: fact.header.origin, p: fields });
  if (!base || base.header.original_subject !== fact.header.original_subject) return { line: full, full: true };
  const changed: ProbePayload = {};
  for (const [key, value] of Object.entries(fact.payload)) {
    if (key !== "ts" && key !== "extra" && value !== base.payload[key]) changed[key] = value;
  }
  let patch: Record<string, unknown> | null = null;
  if (fact.payload.extra !== base.payload.extra) {
    patch = extraPatch(base.payload.extra ?? null, fact.payload.extra ?? null);
    if (!patch) changed.extra = fact.payload.extra ?? null;
  }
  const repeat = JSON.stringify({ ...envelope, b: base.counter_id, t: fact.payload.ts,
    ...(Object.keys(changed).length ? { c: changed } : {}), ...(patch && Object.keys(patch).length ? { x: patch } : {}),
    ...(canonicalJson(fact.header.origin) === canonicalJson(base.header.origin) ? {} : { g: fact.header.origin }) });
  return repeat.length < full.length ? { line: repeat, full: false } : { line: full, full: true };
}

export function isCompactProbeRecord(record: Record<string, unknown>): boolean {
  return record.journal_version === COMPACT_JOURNAL_VERSION;
}
/** The counter a compact line builds on, or null for a self-contained line. */
export function compactProbeBase(record: Record<string, unknown>): string | null {
  if (record.b === undefined) return null;
  if (typeof record.b !== "string" || !record.b) throw new Error("Invalid compact probe base");
  return record.b;
}

/**
 * The canonical probe and the flat record a version 2 line would have carried. `base` is the
 * accepted fact named by `b`; the caller resolves it, because only the caller has the facts.
 */
export function expandCompactProbe(record: Record<string, unknown>, base: CanonicalProbe | null): { fact: CanonicalProbe; outer: Record<string, unknown> } {
  const { o, n, r, d, s, g, p, t, c, x } = record;
  if (typeof o !== "string" || !Number.isSafeInteger(n) || Number(n) < 0 || typeof r !== "string" || typeof d !== "string"
      || d.length !== DIGEST_PREFIX || (s !== undefined && s !== "unknown")) throw new Error("Invalid compact probe envelope");
  let fields: Record<string, unknown>;
  let origin: Origin;
  if (compactProbeBase(record) === null) {
    if (!isRecord(p) || g === undefined || t !== undefined || c !== undefined || x !== undefined) throw new Error("Invalid compact probe line");
    fields = { ...p };
    if (!("raw_subject" in fields)) fields.raw_subject = fields.subject;
    origin = g as Origin;
  } else {
    if (!base || typeof t !== "string" || p !== undefined || (c !== undefined && !isRecord(c)) || (x !== undefined && !isRecord(x)))
      throw new Error("Invalid compact probe reference");
    fields = { ...base.payload, ...(c as Record<string, unknown> | undefined), ts: t };
    if (x !== undefined) {
      const extra: unknown = typeof base.payload.extra === "string" ? JSON.parse(base.payload.extra) : null;
      if (!isRecord(extra) || (c !== undefined && "extra" in (c as object))) throw new Error("Invalid compact probe extra patch");
      fields.extra = JSON.stringify({ ...extra, ...(x as Record<string, Json>) });
    }
    origin = g === undefined ? base.header.origin : g as Origin;
  }
  // Absent fields are null in the canonical payload; strict typing rejects anything else.
  for (const key of PROBE_PAYLOAD_KEYS) if (!(key in fields)) fields[key] = null;
  const fact = assembleCanonicalProbe(o, Number(n), probePayload(fields, true),
    { recorded_at: r, original_subject: s === "unknown" ? "unknown" : "recorded", origin });
  if (!fact.payload_digest.startsWith(d)) throw new Error("Compact probe digest mismatch");
  return { fact, outer: { ...fact.payload, canonical_probe: fact, journal_version: COMPACT_JOURNAL_VERSION, journal_entry_id: record.journal_entry_id } };
}

/**
 * A journal's lines, oldest first, as the flat records version 2 carried. For readers without a
 * fact database: a reference resolves against the lines before it.
 */
export function expandProbeJournal(lines: readonly string[]): Record<string, unknown>[] {
  const accepted = new Map<string, CanonicalProbe>();
  return lines.map(line => {
    const record: unknown = JSON.parse(line);
    if (!isRecord(record) || !isCompactProbeRecord(record)) return record as Record<string, unknown>;
    const baseId = compactProbeBase(record);
    const { fact, outer } = expandCompactProbe(record, baseId ? accepted.get(baseId) ?? null : null);
    accepted.set(fact.counter_id, fact);
    return outer;
  });
}
