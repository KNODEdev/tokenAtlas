import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../../db/sqlite";
import { createTestDatabase } from "../../sync/test-support";
import { prepareProbeReaderFixture } from "../probe-reader.fixture";
import { readPreparedProbeAccountingRevision, readPreparedProbeAccountingRevisions } from "./probe-account-reader";

test("batched accounting revisions equal independent ranges across both clocks, corrections and reopen", () => {
  const temp = createTestDatabase();
  let db = new Database(temp.dbPath);
  const ranges: Array<readonly [string, string]> = [
    ["2026-01-01", "2026-01-02"], ["2026-01-02", "2026-01-03"],
    ["2026-01-01", "2026-01-04"], ["2026-01-04", "2026-01-05"],
    ["2026-01-01", "2026-01-02"],
  ];
  const verify = () => {
    const before = db.query("SELECT total_changes() n").get();
    const expected = ranges.map(([from, until]) => readPreparedProbeAccountingRevision(db, "codex", "seat", from, until));
    expect(readPreparedProbeAccountingRevisions(db, "codex", "seat", ranges)).toEqual(expected);
    expect(db.query("SELECT total_changes() n").get()).toEqual(before);
    return expected;
  };
  try {
    const insert = db.query("INSERT INTO probe_windows(provider,subject,ts,kind,window_minutes,used_percent,ok,reported_percent_side) VALUES('codex',?,?,'secondary',10080,20,1,'used')");
    insert.run("seat", "2026-01-01T12:00:00.000Z");
    insert.run("seat", "2026-01-02T00:00:00.000Z");
    insert.run("other", "2026-01-01T12:00:00.000Z");
    prepareProbeReaderFixture(db, [{ id: "seat", vendor: "codex" }, { id: "other", vendor: "codex" }], undefined, false);
    // One reading belongs to each clock's separate day; it counts once in their union.
    db.query("UPDATE probe_sources SET observation_at=?,revision=11 WHERE probe_id=1").run(Date.parse("2026-01-03"));
    const initial = verify();
    expect(initial[0]?.[1][0]).toEqual(["readings", 1]);
    expect(initial[1]?.[1][0]).toEqual(["readings", 1]);
    expect(initial[2]?.[1][0]).toEqual(["readings", 2]);
    expect(initial[3]?.[1][0]).toEqual(["readings", 0]);
    expect(readPreparedProbeAccountingRevisions(db, "codex", "seat", [])).toEqual([]);
    db.query("UPDATE probe_sources SET revision=revision+1 WHERE probe_id=1").run();
    const corrected = verify();
    expect(corrected).not.toEqual(initial);
    db.close();
    db = new Database(temp.dbPath);
    expect(verify()).toEqual(corrected);
    db.query("DELETE FROM probe_sources WHERE probe_id=1").run();
    expect(verify()).not.toEqual(corrected);
  } finally { db.close(); fs.rmSync(temp.directory, { recursive: true, force: true }); }
});

test("batched accounting revisions preserve the unprepared-index signal", () => {
  const db = new Database(":memory:");
  try {
    expect(readPreparedProbeAccountingRevisions(db, "codex", "seat", [["2026-01-01", "2026-01-02"]])).toEqual([null]);
  } finally { db.close(); }
});
