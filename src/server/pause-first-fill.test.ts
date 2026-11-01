import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { FirstFillPublication, hasUnfinishedFirstFills } from "../sync/first-fill";
import { undoStoppedFirstFills } from "./server-sync";
import { removeTestFixture } from "../test-cleanup";

const fixtures: string[] = [];
afterEach(() => { Bun.gc(true); for (const dir of fixtures.splice(0)) removeTestFixture(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

// TALK-001 D12 (REQ-064 AC2): Pause can stop a process between first-fill batches. What it published so far must
// not stay readable while paused: the fill is undone at once and the vendor's schema objects come back.
test("a first fill stopped between batches is undone before the import reads as paused", async () => {
  const f = createTestDatabase(); fixtures.push(f.directory);
  const db = new Database(f.dbPath);
  try {
    const schema = () => db.query("SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='claude_events' ORDER BY type,name").all();
    const before = schema();
    expect(before.length).toBeGreaterThan(0);
    const transact = (work: () => void) => db.transaction(work).immediate();
    const fill = FirstFillPublication.begin(db, "claude", ["claude_events"], transact);
    // One batch committed, then the process is gone (no restore, no commit).
    fill.move(() => { db.exec("INSERT INTO claude_events(store,call_id,path,ts,model) VALUES('live','a','a.jsonl','2026-10-01T00:00:00Z','m')"); return true; });
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 1 });
    expect(hasUnfinishedFirstFills(db)).toBe(true);

    expect(await undoStoppedFirstFills(db)).toEqual(["claude"]);
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 0 });
    expect(hasUnfinishedFirstFills(db)).toBe(false);
    expect(schema()).toEqual(before);
    // Nothing left to undo: a second call is a no-op.
    expect(await undoStoppedFirstFills(db)).toEqual([]);
  } finally { db.close(); }
});
