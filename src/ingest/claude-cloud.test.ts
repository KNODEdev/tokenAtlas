import { expect, test } from "bun:test";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import * as schema from "../db/schema";
import { applyDrizzleMigrations } from "../db/migrate";
import { mergeClaudePublicationRows } from "../sync/claude-source-publication";
import { upsertClaudeEvents } from "./claude";
import { CLAUDE_CLOUD_ENTRYPOINT } from "./claude-cloud";
import { ClaudeFirstFill } from "./claude-first-fill";
import { identityCompanion } from "./claude-companion";
import { addClaudeAuditCompanions } from "../sync/source-input-selection";
import fs from "node:fs";
import os from "node:os";

// The same call read twice: a teleported transcript copy (final output, wrong place) and the cloud reading
// (no output on the call row, its turn row carries it; place mapped to the local clone).
const transcript = { store: "live", call_id: "msg_1", ts: "2026-10-21T07:00:02.500Z", path: "claude/PC/teleport/a.jsonl",
  cwd: "H:/TMP/teleport-clone", project: "teleport-clone", entrypoint: "claude-desktop", session_id: "local",
  in_uncached: 2, in_cache_read: 100, in_cache_write: 5, out_total: 1484, out_thinking: 154 };
const cloud = { ...transcript, path: "claude/PC-cloud/session_x.events.jsonl", cwd: "C:/example/projects/SampleApp", project: "SampleApp",
  entrypoint: CLAUDE_CLOUD_ENTRYPOINT, session_id: "s-1", out_total: 0, out_thinking: 0 };

function database() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  applyDrizzleMigrations(db, path.resolve(import.meta.dir, "../../drizzle"));
  return { sqlite, db };
}
const stored = (sqlite: Database) => sqlite.query("SELECT path, cwd, project, entrypoint, session_id, out_total FROM claude_events").all();
const expected = (row: typeof cloud) =>
  [{ path: row.path, cwd: row.cwd, project: row.project, entrypoint: row.entrypoint, session_id: row.session_id, out_total: row.out_total }];

test("a cloud reading replaces a transcript copy whole and is never replaced by one", () => {
  for (const order of [[transcript, cloud], [cloud, transcript]]) {
    const { sqlite, db } = database();
    try {
      for (const row of order) upsertClaudeEvents(db, [row]);
      expect(stored(sqlite)).toEqual(expected(cloud));
    } finally { sqlite.close(); }
  }
  // Between transcript copies the one with more output still wins.
  const { sqlite, db } = database();
  try {
    upsertClaudeEvents(db, [{ ...transcript, out_total: 3 }]);
    upsertClaudeEvents(db, [transcript]);
    expect((sqlite.query("SELECT out_total FROM claude_events").get() as { out_total: number }).out_total).toBe(1484);
  } finally { sqlite.close(); }
});

test("publication and the first fill keep the cloud reading the same way", () => {
  const columns = Object.keys(cloud);
  expect(mergeClaudePublicationRows([transcript, cloud], columns)).toMatchObject({ path: cloud.path, cwd: cloud.cwd, out_total: 0 });
  expect(mergeClaudePublicationRows([cloud, transcript], columns)).toMatchObject({ path: cloud.path, cwd: cloud.cwd, out_total: 0 });
  expect(mergeClaudePublicationRows([{ ...transcript, out_total: 3 }, transcript], columns)).toMatchObject({ out_total: 1484 });
  for (const order of [[transcript, cloud], [cloud, transcript]]) {
    const { sqlite } = database();
    try {
      const bulk = new ClaudeFirstFill(sqlite);
      for (const row of order) bulk.append([row]);
      bulk.finish();
      bulk.close();
      expect(stored(sqlite)).toEqual(expected(cloud));
    } finally { sqlite.close(); }
  }
});

test("a cloud session's events are read again when its declaration changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cloud-companion-"));
  try {
    const events = path.join(dir, "session_x.events.jsonl"), declaration = path.join(dir, "session_x.session.jsonl");
    fs.writeFileSync(events, "{}\n"); fs.writeFileSync(declaration, "{}\n");
    expect(identityCompanion("live", events)).toBe(declaration);
    const files = [declaration];
    const { sqlite } = database();
    try { addClaudeAuditCompanions(sqlite, files); } finally { sqlite.close(); }
    expect(files).toEqual([declaration, events]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
