import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "../sync/test-support";
import { ingestClaude } from "./claude";
import { ingestGeminiAsync } from "./gemini";
import { ingestGrokAsync } from "./grok";

const temporaryDirectories: string[] = [];
const january = "2026-01-10T10:00:00.000Z";

function fixture(): { directory: string; dbPath: string } {
  const created = createTestDatabase();
  temporaryDirectories.push(created.directory);
  return created;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())) continue;
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can retain a SQLite handle until process teardown.
    }
  }
});

describe("replacement dirty ranges", () => {
  test("Claude includes a deleted file's previous timestamps", async () => {
    const { directory, dbPath } = fixture();
    const transcript = path.join(directory, "empty.jsonl");
    fs.writeFileSync(transcript, "");
    const sqlite = new Database(dbPath);
    sqlite
      .query("INSERT INTO claude_events (store, call_id, ts, path) VALUES ('live', 'old', ?, ?)")
      .run(january, transcript);
    sqlite.close();

    const result = await ingestClaude({
      dbPath,
      path: transcript,
      store: "live",
      force: true,
    });

    expect(result.dirtyRange).toEqual({ from: january, to: january });
  });

  test("Grok includes a deleted file's previous timestamps", async () => {
    const { directory, dbPath } = fixture();
    const sessionsRoot = path.join(directory, "sessions");
    const transcript = path.join(sessionsRoot, "repo", "session", "updates.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "");
    const sqlite = new Database(dbPath);
    sqlite
      .query(
        "INSERT INTO grok_events (store, session_id, prompt_id, ts, model, path) VALUES ('grok', 's', 'p', ?, 'grok', ?)"
      )
      .run(january, transcript);
    sqlite.close();

    const result = (await ingestGrokAsync(sessionsRoot, "grok", { atlasPath: dbPath, force: true }));

    expect(result.dirtyRange).toEqual({ from: january, to: january });
  });

  test("Gemini includes a deleted conversation's previous timestamps", async () => {
    const { directory, dbPath } = fixture();
    const conversations = path.join(directory, "conversations");
    const conversation = path.join(conversations, "conversation.db");
    fs.mkdirSync(conversations, { recursive: true });
    const source = new Database(conversation, { create: true });
    source.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    source.close();
    const sqlite = new Database(dbPath);
    sqlite
      .query(
        "INSERT INTO gemini_events (store, conversation_id, gen_idx, ts, ts_basis, path) VALUES ('main', 'conversation', 0, ?, 'conversation', ?)"
      )
      .run(january, conversation);
    sqlite.close();

    const result = (await ingestGeminiAsync(conversations, "main", { archivedInput: true,
      atlasPath: dbPath,
      rootDir: process.cwd(),
      force: true,
    }));

    expect(result.dirtyRange).toEqual({ from: january, to: january });
  });
});
