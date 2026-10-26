import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { ParsePool, nativeParserBinary } from "./parse-pool";
import { parentThreadId } from "../projects/parents";

test("native Codex parsing preserves source.thread_spawn parent when thread_source is only a label", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-parent-native-")), file = path.join(directory, "rollout.jsonl");
  const parent = "11111111-1111-4111-8111-111111111111";
  const records = [
    { type: "session_meta", payload: { id: "22222222-2222-4222-8222-222222222222", thread_source: "subagent", cwd: "C:/Temp/arbitrary-id",
      source: { subagent: { other: "ignored-label", thread_spawn: { parent_thread_id: parent, depth: 1 } } } } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-10-15T10:00:00Z", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 }, total_token_usage: { input_tokens: 10, output_tokens: 5 } } } },
  ];
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const pool = new ParsePool(1, { binary: process.env.TOKENATLAS_TEST_PARSER ?? nativeParserBinary() });
  try {
    const parsed = await pool.run("codex", { file, size: fs.statSync(file).size });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") throw new Error("Parser did not return a rollout");
    const event = parsed.parse.events[0]!;
    expect(parentThreadId(event[2] as string)).toBe(parent);
    expect(event.slice(6, 11)).toEqual([10, 2, 0, 5, 0]);
    expect(event[11]).toBe("C:/Temp/arbitrary-id");
  } finally { await pool.close(); fs.unlinkSync(file); fs.rmdirSync(directory); }
});
