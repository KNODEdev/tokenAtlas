import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { ensureRawSyncIndexes } from "../db/migrate";
import { acceptProbeFact, createProbeCollection, legacyJournalProbe, recordProbeDelivery } from "../db/probe-facts";
import { digest } from "../config/canonical-json";
import { createTestDatabase } from "./test-support";
import { removeTestFixture } from "../test-cleanup";
import { gaugeStageEvidence } from "./gauge-stage-evidence";

test("sparse evidence preserves unselected immutable conflicts, deliveries, and legacy ambiguity", () => {
  const fixtures = [createTestDatabase(), createTestDatabase(), createTestDatabase()];
  const [active, stage, reference] = fixtures.map(f => new Database(f.dbPath)) as [Database, Database, Database];
  let evidence: ReturnType<typeof gaugeStageEvidence> | undefined;
  try {
    for (const db of [active, stage, reference]) ensureRawSyncIndexes(db);
    const row = { provider: "codex", subject: "shared", ts: "2026-09-19T10:00:00Z", kind: "primary", used_percent: 42, reported_percent_side: "used" };
    const prior = createProbeCollection([row])[0]!;
    active.exec("BEGIN"); reference.exec("BEGIN"); stage.exec("BEGIN");
    acceptProbeFact(active, prior); acceptProbeFact(reference, prior);
    recordProbeDelivery(active, prior, "unselected-receipt", { role: "archive", received_by: "remote" });
    // These facts belong to an unselected input; selected journal replay still needs their identity evidence.
    for (let i = 0; i < 100; i++) acceptProbeFact(active, createProbeCollection([{ ...row, ts: `2025-01-01T00:${String(i % 60).padStart(2, "0")}:00Z` }])[0]!);
    active.exec("COMMIT");
    evidence = gaugeStageEvidence(stage, fixtures[0]!.dbPath);
    const changed = { ...prior, payload: { ...prior.payload, used_percent: 43 } };
    changed.payload_digest = digest(changed.payload);
    evidence.hydrate(null, row, "new-delivery", changed);
    expect(() => acceptProbeFact(stage, changed)).toThrow("counter-identity-conflict");
    expect(() => acceptProbeFact(reference, changed)).toThrow("counter-identity-conflict");
    expect(stage.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 1 });
    expect(acceptProbeFact(stage, prior)).toBe(false);
    expect(stage.query("SELECT * FROM probe_fact_deliveries").all()).toEqual(active.query("SELECT * FROM probe_fact_deliveries").all());
    expect(stage.query("SELECT * FROM probe_counters WHERE id=?").get(prior.counter_id))
      .toEqual(reference.query("SELECT * FROM probe_counters WHERE id=?").get(prior.counter_id));
    evidence.hydrate(null, row, "legacy-new");
    legacyJournalProbe(stage, row, "legacy-new");
    legacyJournalProbe(reference, row, "legacy-new");
    expect(stage.query("SELECT reason,count(*) n FROM probe_fact_conflicts GROUP BY reason").all())
      .toEqual(reference.query("SELECT reason,count(*) n FROM probe_fact_conflicts GROUP BY reason").all());
    expect(stage.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 2 });
    for (const db of [active, stage]) {
      const plan = db.query("EXPLAIN QUERY PLAN SELECT id FROM probe_counters WHERE json_extract(payload,'$.provider')=? AND json_extract(payload,'$.ts')=?").all("codex", row.ts);
      expect(JSON.stringify(plan)).toContain("probe_counter_legacy_coordinates");
    }
  } finally {
    evidence?.close(); active.close(); stage.close(); reference.close();
    for (const f of fixtures) removeTestFixture(f.directory, { recursive: true, force: true });
  }
});
