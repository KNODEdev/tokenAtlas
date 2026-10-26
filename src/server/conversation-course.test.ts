import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { prepareGlobalFixture } from "./global-usage.fixture";
import { fixtureCodexRateCard } from "./codex-ledger.fixture";
import { handleConversationCourse, readConversationCourse } from "./conversation-course";
import type { RateCard } from "./pricing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rates = { in_uncached: 2, in_cache_read: 1, in_cache_write: 3, in_cache_write_5m: 3, in_cache_write_1h: 4, out_total: 8 };
const card: RateCard = fixtureCodexRateCard({ version: 2, currency: "USD", unit: "per 1M", vendors: Object.fromEntries(
  ["openai", "anthropic", "google", "zai", "xai"].map(vendor => [vendor, { models: { test: rates } }])) });
const databases: Database[] = [], folders: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(path = ":memory:") {
  const sqlite = new Database(path); databases.push(sqlite);
  applyDrizzleMigrations(drizzle(sqlite));
  sqlite.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,speed TEXT,
    in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,billing_mode TEXT);
    INSERT INTO events VALUES(1,'archive','a.jsonl',1,'2026-09-09T12:00:00Z','test','standard',100,60,0,10,'standard'),
      (2,'archive','a.jsonl',2,'2026-09-09T12:01:00Z','test','standard',200,120,0,20,'standard'),
      (3,'archive','b.jsonl',1,'2026-09-09T12:02:00Z','test','standard',900,0,0,0,'standard');
    INSERT INTO claude_events(id,store,call_id,session_id,ts,path,model,in_uncached,in_cache_read,in_cache_write,cache_write_5m,out_total)
      VALUES(1,'one','a','session','2026-09-09T12:00:00Z','a','test',100,200,50,50,10),
      (2,'one','b','session','2026-09-09T12:01:00Z','a','test',200,400,100,100,20),
      (3,'copy','a','session','2026-09-09T12:00:00Z','a','test',100,200,50,50,10),
      (4,'one','c','other','2026-09-09T12:02:00Z','b','test',900,0,0,0,0);
    INSERT INTO gemini_events(id,store,conversation_id,gen_idx,ts,ts_basis,path,model,fresh_in,cached_in,out_total)
      VALUES(1,'agy','g',2,'2026-09-09T10:00:00Z','conversation','g','test',20,40,2),
      (2,'agy','g',1,'2026-09-09T12:00:00Z','conversation','g','test',10,20,1);
    INSERT INTO oc_events(id,store,message_id,session_id,ts,model,provider,in_tok,cache_read,out_tok,reasoning)
      VALUES(1,'oc','m','o','2026-09-09T12:00:00Z','test','zai',10,20,30,5);
    INSERT INTO grok_events(id,store,source_id,session_id,prompt_id,model,ts,in_tok,cached_in,out_tok,model_calls,cost_ticks,path)
      VALUES(1,'grok','file','s','p','test','2026-09-09T12:00:00Z',100,60,10,3,100,'g');`);
  prepareGlobalFixture(sqlite, card);
  return { sqlite, rateCards: card, homeToSubId: new Map<string, string>() };
}
test("Claude detail uses canonical session facts and exact saved money; independent expected rates reconcile", () => {
  const ctx = fixture(), changes = ctx.sqlite.query("SELECT total_changes() n").get();
  const data = readConversationCourse(ctx, "claude", 1)!;
  expect(data.calls).toHaveLength(2);
  expect(data.calls[0]!.tokens).toEqual({ input: 100, cache_read: 200, cache_write: 50, output: 10 });
  expect(data.calls[0]!.api_usd).toBeCloseTo((100 * 2 + 200 + 50 * 3 + 10 * 8) / 1e6, 12);
  expect(readConversationCourse(ctx, "claude", 3)).toEqual(data);
  expect(ctx.sqlite.query("SELECT total_changes() n").get()).toEqual(changes);
});
test("Codex detail is limited to its transcript and retains sub-cent prices", () => {
  const data = readConversationCourse(fixture(), "codex", 1)!;
  expect(data.calls).toHaveLength(2);
  expect(data.calls[0]!.tokens).toEqual({ input: 40, cache_read: 60, cache_write: 0, output: 10 });
  expect(data.calls[0]!.api_usd).toBeCloseTo((40 * 2 + 60 + 10 * 8) / 1e6, 12);
});
test("provider units and generation order remain explicit; reasoning is not counted twice", () => {
  const ctx = fixture();
  expect(readConversationCourse(ctx, "gemini", 1)!.calls.map(c => c.tokens!.input)).toEqual([10, 20]);
  expect(readConversationCourse(ctx, "gemini", 1)!.unit).toBe("generation");
  expect(readConversationCourse(ctx, "grok", 1)!.unit).toBe("turn");
  expect(readConversationCourse(ctx, "opencode", 1)!.calls[0]!.tokens!.output).toBe(35);
});
test("missing prices and invalid counters remain absent", () => {
  const ctx = fixture();
  ctx.sqlite.exec("UPDATE claude_events SET model='unknown' WHERE id=2");
  prepareGlobalFixture(ctx.sqlite, card);
  expect(readConversationCourse(ctx, "claude", 1)!.calls[1]!.api_usd).toBeNull();
  ctx.sqlite.exec("UPDATE claude_events SET in_cache_write=1,cache_write_5m=10 WHERE id=2");
  prepareGlobalFixture(ctx.sqlite, card);
  expect(readConversationCourse(ctx, "claude", 1)!.calls[1]!.tokens).toBeNull();
});
test("correction, repeated publication and fresh readonly reopen preserve the same prepared result", () => {
  const folder = mkdtempSync(join(tmpdir(), "atlas-conversation-")); folders.push(folder);
  const path = join(folder, "trial.sqlite"), ctx = fixture(path);
  ctx.sqlite.exec("UPDATE claude_events SET in_uncached=300 WHERE id=2"); prepareGlobalFixture(ctx.sqlite, card);
  const corrected = readConversationCourse(ctx, "claude", 1)!;
  expect(corrected.calls[1]!.tokens!.input).toBe(300);
  expect(corrected.calls[1]!.api_usd).toBeCloseTo((300 * 2 + 400 + 100 * 3 + 20 * 8) / 1e6, 12);
  prepareGlobalFixture(ctx.sqlite, card);
  expect(readConversationCourse(ctx, "claude", 1)).toEqual(corrected);
  const readonly = new Database(path, { readonly: true }); databases.push(readonly);
  expect(readConversationCourse({ ...ctx, sqlite: readonly }, "claude", 1)).toEqual(corrected);
  expect(readonly.query("SELECT total_changes() n").get()).toEqual({ n: 0 });
});
test("rejects invalid references and reports a missing conversation", () => {
  const ctx = fixture();
  for (const query of ["vendor=constructor&reference_id=1", "vendor=codex&reference_id=-1", "vendor=claude&reference_id=1e3"])
    expect(handleConversationCourse(ctx, new URL(`http://local/api/conversation-course?${query}`)).status).toBe(400);
  expect(handleConversationCourse(ctx, new URL("http://local/api/conversation-course?vendor=claude&reference_id=999" )).status).toBe(404);
});
