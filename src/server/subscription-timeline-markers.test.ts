import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCodexTimelineMarkers } from "./codex-timeline-markers";
import type { TimelineMarkersResponse } from "../shared/codex-accounting";
import { MODEL_TIMELINE_SCHEMA, advanceModelTimelines } from "../db/model-timeline";

test("provider markers isolate edits and derive dated API changes without asserting allowance changes", async () => {
  const db = new Database(":memory:"), root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-provider-markers-"));
  db.exec("CREATE TABLE events(model TEXT,ts TEXT); CREATE TABLE claude_events(model TEXT,ts TEXT); INSERT INTO events VALUES ('gpt-model','2026-08-01'); INSERT INTO claude_events VALUES ('claude-model','2026-08-02')");
  db.exec(MODEL_TIMELINE_SCHEMA);
  while (advanceModelTimelines(db, { budgetMs: 10000 }).pending) {}
  const card = { version: 1, currency: "USD", unit: "per 1M", vendors: { anthropic: { models: { "claude-model": { in_uncached: 2, in_cache_read: 0.2, in_cache_write_5m: 2.5, in_cache_write_1h: 4, out_total: 10, until: "2026-08-10", after: { in_uncached: 1, in_cache_read: 0.1, in_cache_write_5m: 1.25, in_cache_write_1h: 2, out_total: 5 } } } } } };
  const read = async (provider: string) => (await handleCodexTimelineMarkers(db, new Request("http://local/markers"), root, card, provider)).json() as Promise<TimelineMarkersResponse>;
  try {
    const claude = await read("claude");
    expect(claude.automatic.some(m => m.id === "model:claude-model")).toBe(true);
    expect(claude.automatic.some(m => m.id === "model:gpt-model")).toBe(false);
    expect(claude.automatic.find(m => m.id === "model:release:claude-fable-5-2"))
      .toMatchObject({ day: "2026-11-09", visible: true });
    const gemini = await read("google");
    expect(gemini.automatic.map(m => [m.id, m.day, m.visible])).toEqual([
      ["model:release:gemini-4-argon", "2026-10-13", true],
      ["model:release:gemini-4-carbon", "2026-11-10", true],
      ["model:release:gemini-4-hydrogen", "2026-11-12", true],
    ]);
    const price = claude.automatic.find(m => m.id.startsWith("price:"))!;
    expect(price.day).toBe("2026-08-11"); expect(price.note).toContain("Impact on subscription allowance: unverified");
    const marker = { id: "custom:local", day: "2026-08-12", label: "Claude event", note: "User declaration", visible: true, color: "warn" };
    const request = new Request("http://local/markers", { method: "POST", body: JSON.stringify({ revision: claude.revision, marker }) });
    expect((await handleCodexTimelineMarkers(db, request, root, card, "claude")).status).toBe(200);
    expect((await read("claude")).markers).toHaveLength(1);
    const codex = await read("codex");
    expect(codex.markers).toHaveLength(0);
    expect(codex.automatic.filter(m => m.id.startsWith("model:release:")).map(m => [m.id, m.day, m.visible])).toEqual([
      ["model:release:gpt-6.2-astra", "2026-11-17", true],
      ["model:release:gpt-6.2-sol", "2026-11-17", true],
    ]);
    expect((await read("grok")).automatic).toHaveLength(0);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
