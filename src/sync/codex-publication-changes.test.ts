import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { changedCodexFacts } from "./codex-publication-changes";
import { createTestDatabase, importCodexHome } from "./test-support";
import { removeTestFixture } from "../test-cleanup";
import type { DeltaIdentity } from "./vendor-publication-schema";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const transcript = line({ type: "session_meta", payload: { id: "classifier-session", originator: "codex-tui", thread_source: "user" } })
  + line({ type: "turn_context", payload: { model: "gpt-test" } })
  + line({ type: "token_usage_record", timestamp: "2026-09-08T00:00:00Z", payload: { thread_id: "classifier-thread",
    response_id: "classifier-response", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } });

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// One import is copied for every reading: parsing dominates the cost of these cases.
let template: Promise<string> | undefined;
const imported = () => template ??= (async () => {
  const { directory, dbPath } = createTestDatabase(), file = path.join(directory, "codex", "sessions", "classifier.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, transcript);
  await importCodexHome(dbPath, path.join(directory, "codex"));
  const db = new Database(dbPath); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  return dbPath;
})();
afterAll(async () => { if (template) removeTestFixture(path.dirname(await template), { recursive: true, force: true }); });

/** Active and staged readings of the same transcript; each test then edits only the staged copy. */
async function readings() {
  const source = await imported();
  const open = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-classifier-")), dbPath = path.join(directory, "atlas.sqlite");
    fs.copyFileSync(source, dbPath);
    const db = new Database(dbPath);
    cleanup.push(() => { db.close(); removeTestFixture(directory, { recursive: true, force: true }); });
    return db;
  };
  const active = open(), staged = open();
  const identity = active.query("SELECT home,path FROM codex_file_evidence").get() as DeltaIdentity;
  expect(active.query("SELECT json_type(first_token_json,'$.bookmark') AS kind FROM codex_file_evidence").get()).toEqual({ kind: "object" });
  const rate = (db: Database, used: number) => db.query(`INSERT INTO ratelimit(home,path,ts,window_minutes,used_percent,resets_at,
    plan_type,limit_id,limit_name,source_offset,source_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(identity.home!, identity.path!, "2026-09-08T00:00:00Z", 300, used, "2026-09-08T05:00:00Z", "pro", "codex", null, 1, 0);
  rate(active, 10); rate(staged, 10);
  const moveBookmark = () => staged.exec("UPDATE codex_file_evidence SET first_token_json=json_set(first_token_json,'$.bookmark.size',987654)");
  return { active, staged, identity, moveBookmark };
}

test("a moved parser bookmark alone is not a fact change", async () => {
  const r = await readings();
  r.moveBookmark();
  expect(changedCodexFacts(r.active, r.staged, [r.identity])).toEqual([]);
});

test("a moved bookmark with a changed event, rate limit or evidence column still publishes its facts", async () => {
  for (const change of [
    "UPDATE events SET in_tok=in_tok+1",
    "UPDATE ratelimit SET used_percent=used_percent+1",
    "UPDATE codex_file_evidence SET source_sha256='0'",
    "UPDATE codex_file_evidence SET first_token_json=json_set(first_token_json,'$.version',-1)",
  ]) {
    const r = await readings();
    r.moveBookmark(); r.staged.exec(change);
    expect({ change, result: changedCodexFacts(r.active, r.staged, [r.identity]) }).toEqual({ change, result: [r.identity] });
  }
});

test("missing or unreadable timing and missing evidence keep the identity changed", async () => {
  for (const [side, change] of [
    ["staged", "UPDATE codex_file_evidence SET first_token_json=NULL"],
    ["active", "UPDATE codex_file_evidence SET first_token_json='not json'"],
    ["staged", "DELETE FROM codex_file_evidence"],
    ["active", "DELETE FROM codex_file_evidence"],
  ] as const) {
    const r = await readings();
    r.moveBookmark(); r[side].exec(change);
    expect({ change, result: changedCodexFacts(r.active, r.staged, [r.identity]) }).toEqual({ change, result: [r.identity] });
  }
});

test("only the bookmark-only identity leaves a mixed batch", async () => {
  const r = await readings(), other: DeltaIdentity = { home: r.identity.home!, path: `${r.identity.path}.absent` };
  r.moveBookmark();
  expect(changedCodexFacts(r.active, r.staged, [other, r.identity])).toEqual([other]);
});
