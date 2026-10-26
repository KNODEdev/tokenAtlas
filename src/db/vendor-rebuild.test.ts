import { afterEach, expect, test } from "bun:test";
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAnalysisTracking } from "./analysis";
import { applyDrizzleMigrations } from "./migrate";
import { analysisRebuildStatus, queueAnalysisRebuild } from "../server/analysis-rebuild";

const temporary: string[] = [];
function database(file = ":memory:"): Database {
  const db = new Database(file, { create: true });
  applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, home TEXT NOT NULL, path TEXT NOT NULL,
    ts TEXT NOT NULL, model TEXT, project_id TEXT, in_tok INTEGER NOT NULL DEFAULT 0,
    cached_in INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
    out_tok INTEGER NOT NULL DEFAULT 0, reasoning_out INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`INSERT INTO events(home,path,ts,model,in_tok,out_tok)
      VALUES('codex-home','codex.jsonl','2026-09-10T12:00:00Z','gpt',10,2);
    INSERT INTO claude_events(store,call_id,path,ts,model,in_uncached,out_total)
      VALUES('claude-store','claude-call','claude.jsonl','2026-09-10T13:00:00Z','opus',20,3);`);
  installAnalysisTracking(db);
  return db;
}
afterEach(() => {
  Bun.gc(true);
  while (temporary.length) {
    const directory = temporary.pop()!;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries:10, retryDelay:50 });
  }
});

test("an all-history vendor selector remains durable across reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-vendor-rebuild-"));
  temporary.push(directory);
  const file = path.join(directory, "atlas.sqlite");
  let db = database(file);
  try {
    const queued = queueAnalysisRebuild(db, {scope:"all",vendors:["claude"]});
    expect(queued).toMatchObject({vendors:["claude"],range:null,state:"queued"});
    db.close();
    db = new Database(file);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation:queued.generation,vendors:["claude"],range:null,state:"queued"
    });
  } finally { db.close(); }
});
