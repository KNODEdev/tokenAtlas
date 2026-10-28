import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParsePool, nativeParserBinary } from "./parse-pool";
import { codexFirstTokenAdapter as adapter } from "../providers/first-token/codex";

const binary = process.env.TOKENATLAS_TTFT_TEST_PARSER ?? nativeParserBinary();
const turn = (id: string, ms: unknown, at = "2026-10-25T10:00:00.000Z") => [
  { type: "turn_context", payload: { turn_id: id, model: "fixture-model" } },
  { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: id } },
  { type: "event_msg", payload: { type: "token_count", rate_limits: { plan_type: "self_serve_business_usage_based" } } },
  { type: "event_msg", timestamp: new Date(Date.parse(at) + 10000).toISOString(),
    payload: { type: "task_complete", turn_id: id, duration_ms: 10000, time_to_first_token_ms: ms } },
];
const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));

test("shared native scan matches the timing reference in full and compact modes, plain and zstd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-native-ttft-")), file = path.join(dir, "f.jsonl");
  const pool = new ParsePool(2, { binary });
  const records = [
    { type: "thread_settings_applied", payload: { thread_settings: { service_tier: "priority", reasoning_effort: "ultra" } } },
    ...turn("fast-ultra", 1500),
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default", reasoning_effort: "high" } } },
    ...turn("standard-high", 2500),
    { type: "thread_settings_applied", payload: { thread_settings: { service_tier: null, reasoning_effort: "medium" } } },
    ...[0, 1000, null, -1, 1.5, "42", true, 11001, Number.MAX_SAFE_INTEGER + 1].flatMap((ms, i) => turn(`t${i}`, ms)),
    ...turn("offset", 500, "2026-10-25T12:00:00.000+02:00"), ...turn("conflict", 1000), turn("conflict", 2000)[3],
    ...turn("unfinished", 2000).slice(0, 3),
    { type: "response_item", payload: { type: "message", role: "assistant", content: "x".repeat(100000) } },
  ];
  const content = records.map(row => JSON.stringify(row)).join("\n") + "\n";
  try {
    fs.writeFileSync(file, content);
    const full = await pool.run("codex", { file, size: Buffer.byteLength(content), validate: true });
    expect(full.kind).toBe("ok");
    if (full.kind !== "ok") throw new Error(full.message);
    expect(sorted(full.parse.firstToken!.turns)).toEqual(sorted(adapter.parse(records)));
    expect(sorted(await adapter.prepare!(pool, file))).toEqual(sorted(adapter.parse(records)));
    fs.writeFileSync(`${file}.zst`, Bun.zstdCompressSync(content)); fs.unlinkSync(file);
    expect(sorted(await adapter.prepare!(pool, file))).toEqual(sorted(adapter.parse(records)));
    const compact = await pool.run("codex", { file, size: 0, firstTokenOnly: true });
    expect(compact.kind === "ok" && Object.keys(compact.parse)).toEqual(["firstToken"]);
    fs.writeFileSync(file, "\uFEFF" + content); fs.unlinkSync(`${file}.zst`);
    expect(sorted(await adapter.prepare!(pool, file))).toEqual(sorted(adapter.parse(records)));
    const escaped = content.replaceAll("task_started", "task_\\u0073tarted").replaceAll("task_complete", "task_\\u0063omplete")
      .replaceAll("turn_context", "turn_\\u0063ontext").replaceAll('"type"', '"t\\u0079pe"');
    fs.writeFileSync(file, escaped);
    expect(sorted(await adapter.prepare!(pool, file))).toEqual(sorted(adapter.parse(records)));
    fs.writeFileSync(file, content + '{"unfinished":');
    expect(sorted(await adapter.prepare!(pool, file))).toEqual(sorted(adapter.parse(records)));
    fs.writeFileSync(file, content + "{broken}\n");
    // Bun's rejects matcher can block child-process delivery; await the native error first.
    let rejected: unknown;
    try { await adapter.prepare!(pool, file); } catch (error) { rejected = error; }
    expect(String(rejected)).toContain("Invalid JSONL record");
  } finally { await pool.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test("a parser without the versioned TTFT result cannot erase existing timing history", async () => {
  const old = { run: async () => ({ kind: "ok", parse: { events: [], rateLimits: [] } }) } as unknown as ParsePool;
  await expect(adapter.prepare!(old, "unused")).rejects.toThrow("no verified first-token output");
});
