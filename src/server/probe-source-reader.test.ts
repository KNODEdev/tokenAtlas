import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy, type CanonicalProbe } from "../db/probe-facts";
import { probeEvidenceReader, resolveProbeEvidence, type IndexedProbeRow } from "./probe-source-reader";
import { probeArchiveSourceOf, type ProbeSourceOptions } from "./probe-source";
import { readProbeSourceCorrections } from "./probe-source-corrections";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The stored-evidence path of the current projection for one row: evidence, then resolution under the options. */
function createProbeSourceReader(sqlite: Database, options: ProbeSourceOptions) {
  const evidence = probeEvidenceReader(sqlite);
  const resolve = (row: IndexedProbeRow) => {
    const proof = evidence(row);
    return { ...resolveProbeEvidence(row.provider, proof, { subject: row.subject as string | undefined, ts: row.ts as string | undefined,
      machine: row.machine ?? null }, options), profiles: proof.profiles };
  };
  return { resolve, sourceOf(row: IndexedProbeRow) { const { profiles: _profiles, ...result } = resolve(row); return result; } };
}

const options: ProbeSourceOptions = {
  archiveRoot: "H:/Archive", defaultLogin: "sample_a",
  declarations: [
    { vendor: "codex", machine: "PC", source_home: "C:/Users/sample_a/.codex-mr", home: "H:/Archive/codex/pc-mr" },
    { vendor: "codex", machine: "LAPTOP", source_home: "C:/Users/sample_a/.codex-mr", home: "H:/Archive/codex/laptop-mr" },
  ],
};

function fixture() {
  const db = new Database(":memory:"); applyDrizzleMigrations(drizzle(db));
  const fact = (machine: string, home: string, ts = "2026-09-01T10:00:00Z") =>
    createProbeCollection([{ provider: "codex", subject: "recorded-account", raw_subject: "recorded-account",
      ts, kind: "weekly", reported_percent_side: "used", used_percent: 20,
      machine, login: "sample_a", source_home: home, extra: null }])[0]!;
  const insert = (canonical: CanonicalProbe) => db.transaction(() => {
    acceptProbeFact(db, canonical);
    const keys = Object.keys(canonical.payload).filter(key => !["raw_subject", "login", "source_home"].includes(key));
    const result = db.query(`INSERT INTO probe_windows(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map(key => canonical.payload[key]!));
    const id = Number(result.lastInsertRowid);
    mapProbeLegacy(db, canonical, id, "published-projection");
    return id;
  }).immediate();
  const row = (id: number) => db.query("SELECT * FROM probe_windows WHERE id=?").get(id) as IndexedProbeRow;
  return { db, fact, insert, row };
}

test("indexed canonical source survives missing projection metadata and a restamped subject on two machines", () => {
  const { db, fact, insert, row } = fixture();
  try {
    const pc = fact("PC", "C:/Users/sample_a/.codex-mr");
    const laptop = fact("LAPTOP", "C:/Users/sample_a/.codex-mr", "2026-09-01T10:01:00Z");
    const pcId = insert(pc), laptopId = insert(laptop);
    db.query("UPDATE probe_windows SET subject='stamped' WHERE id=?").run(pcId);
    expect(probeArchiveSourceOf(row(pcId), options)).toBeNull();
    const before = {
      counters: db.query("SELECT * FROM probe_counters ORDER BY id").all(),
      observations: db.query("SELECT * FROM probe_observations ORDER BY id").all(),
      changes: db.query("SELECT total_changes() AS n").get(),
    };
    const reader = createProbeSourceReader(db, options);
    expect(reader.sourceOf(row(pcId))).toEqual({ source: "codex/pc-mr", basis: "canonical" });
    expect(reader.sourceOf(row(laptopId))).toEqual({ source: "codex/laptop-mr", basis: "canonical" });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before.changes);
    expect(db.query("SELECT * FROM probe_counters ORDER BY id").all()).toEqual(before.counters);
    expect(db.query("SELECT * FROM probe_observations ORDER BY id").all()).toEqual(before.observations);
  } finally { db.close(true); }
});

test("dated correction resolves only verified canonical facts without physical source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-probe-source-"));
  const { db, insert, row } = fixture();
  try {
    fs.writeFileSync(path.join(root, "probe-source-corrections.json"), JSON.stringify({ version: 1, corrections: [{
      provider: "codex", subject: "recorded-account", from: "2026-09-01T00:00:00Z",
      until: "2026-09-02T00:00:00Z", source: "codex/pc-mr", evidence: "owner-declaration",
    }] }));
    const missing = createProbeCollection([{ provider: "codex", subject: "recorded-account", ts: "2026-09-01T10:00:00Z",
      kind: "weekly", reported_percent_side: "used", used_percent: 20, machine: null, login: null,
      source_home: null, extra: null }])[0]!;
    const unknownId = insert(missing);
    const machineOnlyId = insert(createProbeCollection([{ ...missing.payload, machine: "LAPTOP" }])[0]!);
    const physicalId = insert(createProbeCollection([{ ...missing.payload, machine: "LAPTOP", login: "sample_a",
      source_home: "C:/Users/sample_a/.codex-mr" }])[0]!);
    const corrections = readProbeSourceCorrections(root);
    const reader = createProbeSourceReader(db, { ...options, corrections });
    const originals = db.query("SELECT * FROM probe_counters ORDER BY id").all();
    expect(reader.sourceOf(row(unknownId))).toEqual({ source: "codex/pc-mr", basis: "declared-correction" });
    expect(reader.sourceOf(row(machineOnlyId))).toEqual({ source: null, basis: "unresolved-source" });
    expect(reader.sourceOf(row(physicalId))).toEqual({ source: "codex/laptop-mr", basis: "canonical" });
    expect(reader.sourceOf({ ...row(unknownId), subject: "other" })).toEqual({ source: null, basis: "unresolved-source" });
    expect(db.query("SELECT * FROM probe_counters ORDER BY id").all()).toEqual(originals);
  } finally { db.close(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test("canonical profile home owns a Codex probe even when the process login differs", () => {
  const { db, fact, insert, row } = fixture();
  try {
    const id = insert(fact("PC", "C:/Users/sample_c/.codex"));
    const physical = createProbeSourceReader(db, options).resolve(row(id));
    expect(physical.source).toBe("codex/pc-sample_c");
    expect(physical.profiles).toEqual([{ machine: "PC", home: "C:/Users/sample_c/.codex", login: "sample_c" }]);
    expect(row(id).subject).toBe("recorded-account");
  } finally { db.close(true); }
});

test("distinct matching canonical deliveries agree on one physical source without changing originals", () => {
  const { db, fact, insert, row } = fixture();
  try {
    const first = fact("PC", "C:/Users/sample_a/.codex-mr"), duplicate = fact("PC", "C:/Users/sample_a/.codex-mr");
    expect(first.counter_id).not.toBe(duplicate.counter_id);
    const id = insert(first);
    db.transaction(() => { acceptProbeFact(db, duplicate); mapProbeLegacy(db, duplicate, id, "duplicate-delivery"); }).immediate();
    db.query("UPDATE probe_windows SET subject='restamped' WHERE id=?").run(id);
    const originals = {
      counters: db.query("SELECT * FROM probe_counters ORDER BY id").all(),
      observations: db.query("SELECT * FROM probe_observations ORDER BY id").all(),
      mappings: db.query("SELECT * FROM probe_fact_legacy_map ORDER BY id").all(),
      changes: db.query("SELECT total_changes() AS n").get(),
    };
    expect(createProbeSourceReader(db, options).sourceOf(row(id))).toEqual({ source: "codex/pc-mr", basis: "canonical" });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(originals.changes);
    expect(db.query("SELECT * FROM probe_counters ORDER BY id").all()).toEqual(originals.counters);
    expect(db.query("SELECT * FROM probe_observations ORDER BY id").all()).toEqual(originals.observations);
    expect(db.query("SELECT * FROM probe_fact_legacy_map ORDER BY id").all()).toEqual(originals.mappings);
  } finally { db.close(true); }
});

test("same-source canonical duplicates expose every verified physical profile", () => {
  const { db, fact, insert, row } = fixture();
  try {
    const primary = fact("PC", "C:/Users/sample_a/.codex-mr");
    const id = insert(primary);
    const alternate = fact("PC", "D:/Profiles/sample_a/.codex-mr");
    const declarations = [...options.declarations,
      { vendor: "codex", machine: "PC", source_home: "D:/Profiles/sample_a/.codex-mr", home: "H:/Archive/codex/pc-mr" }];
    db.transaction(() => { acceptProbeFact(db, alternate); mapProbeLegacy(db, alternate, id, "same-source-copy"); }).immediate();
    const resolved = createProbeSourceReader(db, { ...options, declarations }).resolve(row(id));
    expect(resolved.source).toBe("codex/pc-mr");
    expect(resolved.profiles.map(profile => profile.home).sort()).toEqual([
      "C:/Users/sample_a/.codex-mr", "D:/Profiles/sample_a/.codex-mr",
    ]);
  } finally { db.close(true); }
});

test("unknown physical candidate prevents a known source from proving ownership", () => {
  for (const includeKnown of [false, true]) {
    const { db, fact, insert, row } = fixture();
    try {
      const unknown = fact("PC", "C:/Users/sample_a/.codex-unmapped");
      const id = insert(unknown);
      const second = includeKnown ? fact("PC", "C:/Users/sample_a/.codex-mr")
        : fact("PC", "C:/Users/sample_a/.codex-other");
      db.transaction(() => { acceptProbeFact(db, second); mapProbeLegacy(db, second, id, "second-delivery"); }).immediate();
      expect(createProbeSourceReader(db, options).sourceOf(row(id))).toEqual({ source: null, basis: "unresolved-source" });
    } finally { db.close(true); }
  }
});

test("genuine sample correction invalidates an old pointer; missing and competing links stay unknown", () => {
  const { db, fact, insert, row } = fixture();
  try {
    const first = fact("PC", "C:/Users/sample_a/.codex-mr");
    const id = insert(first);
    const reader = createProbeSourceReader(db, options);
    expect(reader.sourceOf(row(id))).toEqual({ source: "codex/pc-mr", basis: "canonical" });
    db.query("UPDATE probe_fact_legacy_map SET evidence_hash='corrupt' WHERE legacy_id=?").run(id);
    expect(reader.sourceOf(row(id))).toEqual({ source: null, basis: "conflicting-link" });
    db.query("UPDATE probe_fact_legacy_map SET evidence_hash=? WHERE legacy_id=?").run(first.payload_digest, id);
    db.query("UPDATE probe_windows SET used_percent=44 WHERE id=?").run(id);
    expect(reader.sourceOf(row(id))).toEqual({ source: null, basis: "stale-link" });
    db.query("UPDATE probe_windows SET used_percent=20 WHERE id=?").run(id);
    const competing = fact("PC", "C:/Users/sample_a/.codex");
    db.transaction(() => { acceptProbeFact(db, competing); mapProbeLegacy(db, competing, id, "fixture-conflict"); }).immediate();
    expect(reader.sourceOf(row(id))).toEqual({ source: null, basis: "conflicting-link" });
    db.query("DELETE FROM probe_fact_legacy_map WHERE legacy_id=?").run(id);
    expect(reader.sourceOf(row(id))).toEqual({ source: null, basis: "missing-link" });
  } finally { db.close(true); }
});

test("legacy-only fixture uses only captured projection evidence and indexed lookup stays bounded", () => {
  const bare = new Database(":memory:");
  try {
    const reader = createProbeSourceReader(bare, options);
    expect(reader.sourceOf({ id: 1, provider: "codex", machine: "PC", extra: '{"home":"C:/Users/sample_a/.codex"}' }))
      .toEqual({ source: "codex/pc-sample_a", basis: "projection-only" });
    expect(reader.sourceOf({ id: 2, provider: "codex", machine: "PC", subject: "stamped" }))
      .toEqual({ source: null, basis: "unresolved-source" });
  } finally { bare.close(true); }
  const { db, fact, insert } = fixture();
  try {
    insert(fact("PC", "C:/Users/sample_a/.codex-mr"));
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT m.counter_id,c.payload,o.header FROM probe_fact_legacy_map m
      LEFT JOIN probe_counters c ON c.id=m.counter_id
      LEFT JOIN probe_observations o ON o.id=c.observation_id
      WHERE m.namespace=? AND m.legacy_id=?`).all("namespace", 1) as {detail:string}[];
    expect(plan.some(step => step.detail.includes("probe_fact_legacy_pointer")
      && step.detail.includes("namespace=?") && step.detail.includes("legacy_id=?"))).toBe(true);
    expect(plan.some(step => step.detail.startsWith("SEARCH c ") && step.detail.includes("id=?"))).toBe(true);
    expect(plan.some(step => step.detail.startsWith("SEARCH o ") && step.detail.includes("id=?"))).toBe(true);
  } finally { db.close(true); }
});
