import { describe, expect, it } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { replaceClaudeFileEvents, upsertClaudeEvents } from "./claude";
import type { NewClaudeEvent } from "../db/schema";
// Two session identities; only an identity is evidence of the account a copy was recorded under.
const KEY_A = "claude:6deed05f-c0a9-41d1-8e7f-fd5baaa36db2:bd47f8bf-640e-4156-ad4a-4d6650376a59";
const KEY_B = "claude:3c56ad18-8472-452a-b5a2-4437e25a7e4a:bd47f8bf-640e-4156-ad4a-4d6650376a59";
describe("ingest write", () => {
  it("keeps a store/call_id identity conflict NULL through later copies", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(`
      CREATE TABLE claude_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store TEXT NOT NULL,
        call_id TEXT NOT NULL,
        session_id TEXT,
        request_id TEXT,
        ts TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        project TEXT,
        cwd TEXT,
        git_branch TEXT,
        entrypoint TEXT,
        is_sidechain INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        attribution_agent TEXT,
        service_tier TEXT,
        speed TEXT,
        cc_version TEXT,
        path TEXT NOT NULL,
        in_uncached INTEGER NOT NULL DEFAULT 0,
        in_cache_read INTEGER NOT NULL DEFAULT 0,
        in_cache_write INTEGER NOT NULL DEFAULT 0,
        cache_write_5m INTEGER NOT NULL DEFAULT 0,
        cache_write_1h INTEGER NOT NULL DEFAULT 0,
        out_total INTEGER NOT NULL DEFAULT 0,
        out_thinking INTEGER NOT NULL DEFAULT 0,
        project_id TEXT,
        subscription_id TEXT,
        account_key TEXT,
        subscription_conflict INTEGER NOT NULL DEFAULT 0,
        resp_ms INTEGER,
        billing_mode TEXT
      );
      CREATE UNIQUE INDEX claude_events_store_call_id_unique ON claude_events (store, call_id);
    `);
    const db = drizzle(sqlite, { schema });
    const row = (key: string | null, sub: string | null, out: number, file: string): NewClaudeEvent => ({
      store: "live",
      call_id: "shared-call",
      ts: "2026-01-02T00:00:00Z",
      path: file,
      account_key: key,
      subscription_id: sub,
      out_total: out,
      in_uncached: out,
      in_cache_read: 0,
      in_cache_write: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      out_thinking: 0,
      is_sidechain: 0,
    });
    const a = (out: number) => row(KEY_A, "claude-a", out, "C:/archive/claude/profile-a/a.jsonl");
    const b = (out: number) => row(KEY_B, "claude-b", out, "C:/archive/claude/profile-b/b.jsonl");
    const sequences: NewClaudeEvent[][] = [
      [a(10), b(10), a(10)],
      [b(10), a(10), b(10)],
      [a(5), b(50), a(7)],
      [b(50), a(5), b(9)],
    ];
    for (const copies of sequences) {
      sqlite.run(`DELETE FROM claude_events`);
      for (const copy of copies) upsertClaudeEvents(db, [copy]);
      const afterUpsert = sqlite
        .query(
          `SELECT subscription_id, subscription_conflict, out_total, in_uncached FROM claude_events WHERE call_id = 'shared-call'`
        )
        .get() as {
        subscription_id: string | null;
        subscription_conflict: number;
        out_total: number;
        in_uncached: number;
      };
      expect(afterUpsert.subscription_id).toBeNull();
      expect(afterUpsert.subscription_conflict).toBe(1);
      const maxOut = Math.max(...copies.map((c) => c.out_total ?? 0));
      expect(afterUpsert.out_total).toBe(maxOut);
      expect(afterUpsert.in_uncached).toBe(maxOut);
    }
    // Copies without an identity name no account, so their files alone never make a conflict.
    const keyless = (out: number, file: string) => row(null, null, out, file);
    sqlite.run(`DELETE FROM claude_events`);
    upsertClaudeEvents(db, [keyless(10, "C:/archive/claude/profile-a/a.jsonl")]);
    upsertClaudeEvents(db, [keyless(20, "C:/archive/claude/profile-b/b.jsonl")]);
    expect(sqlite.query(`SELECT subscription_id, subscription_conflict, out_total, path FROM claude_events`).get())
      .toEqual({ subscription_id: null, subscription_conflict: 0, out_total: 20, path: "C:/archive/claude/profile-b/b.jsonl" });
  });
});
function conflictTable(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE claude_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store TEXT NOT NULL,
      call_id TEXT NOT NULL,
      session_id TEXT,
      request_id TEXT,
      ts TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      project TEXT,
      cwd TEXT,
      git_branch TEXT,
      entrypoint TEXT,
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      attribution_agent TEXT,
      service_tier TEXT,
      speed TEXT,
      cc_version TEXT,
      path TEXT NOT NULL,
      in_uncached INTEGER NOT NULL DEFAULT 0,
      in_cache_read INTEGER NOT NULL DEFAULT 0,
      in_cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_5m INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0,
      out_total INTEGER NOT NULL DEFAULT 0,
      out_thinking INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      subscription_id TEXT,
      account_key TEXT,
      subscription_conflict INTEGER NOT NULL DEFAULT 0,
      resp_ms INTEGER,
        billing_mode TEXT
    );
    CREATE UNIQUE INDEX claude_events_store_call_id_unique ON claude_events (store, call_id);
  `);
}
describe("replaceClaudeFileEvents production seam", () => {
  it("keeps sticky conflict through A→B and B→A force refresh when the retained path is deleted last", () => {
    const pathA = "C:/archive/claude/profile-a/a.jsonl";
    const pathB = "C:/archive/claude/profile-b/b.jsonl";
    const row = (key: string, sub: string, file: string): NewClaudeEvent => ({
      store: "live",
      call_id: "shared-call",
      ts: "2026-01-02T00:00:00Z",
      path: file,
      account_key: key,
      subscription_id: sub,
      out_total: 10,
      in_uncached: 10,
      in_cache_read: 0,
      in_cache_write: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      out_thinking: 0,
      is_sidechain: 0,
    });
    const a = row(KEY_A, "claude-a", pathA);
    const b = row(KEY_B, "claude-b", pathB);
    const read = (sqlite: Database) =>
      sqlite
        .query(
          `SELECT subscription_id, subscription_conflict, path FROM claude_events WHERE call_id = 'shared-call'`
        )
        .get() as {
        subscription_id: string | null;
        subscription_conflict: number;
        path: string;
      };
    const refresh = (
      db: Parameters<typeof replaceClaudeFileEvents>[0],
      sqlite: Database,
      order: NewClaudeEvent[]
    ) => {
      sqlite.transaction(() => {
        for (const copy of order) {
          replaceClaudeFileEvents(db, sqlite, copy.store, copy.path, [copy]);
        }
      })();
    };
    for (const order of [
      [a, b],
      [b, a],
    ] as NewClaudeEvent[][]) {
      const sqlite = new Database(":memory:");
      conflictTable(sqlite);
      const db = drizzle(sqlite, { schema });
      for (const copy of order) upsertClaudeEvents(db, [copy]);
      const before = read(sqlite);
      expect(before.subscription_id).toBeNull();
      expect(before.subscription_conflict).toBe(1);
      const winnerLast = before.path === pathA ? [b, a] : [a, b];
      refresh(db, sqlite, winnerLast);
      const afterWinnerLast = read(sqlite);
      expect(afterWinnerLast.subscription_id).toBeNull();
      expect(afterWinnerLast.subscription_conflict).toBe(1);
      const forward = [...order];
      refresh(db, sqlite, forward);
      const afterForward = read(sqlite);
      expect(afterForward.subscription_id).toBeNull();
      expect(afterForward.subscription_conflict).toBe(1);
    }
  });
});
