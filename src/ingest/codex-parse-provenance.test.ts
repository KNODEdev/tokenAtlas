import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexFixture, prepareCodexBytes } from "./native-test-support";
import { ParsePool } from "./parse-pool";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const usage = (input = 10) => ({ input_tokens: input, cached_input_tokens: 2, output_tokens: 5 });
const count = (input = 10) => ({ timestamp: "2026-09-08T00:00:00Z", type: "event_msg", payload: {
  type: "token_count", info: { last_token_usage: usage(input), total_token_usage: { input_tokens: input, output_tokens: 5 } },
  rate_limits: { plan_type: "plus", primary: { window_minutes: 300, used_percent: 12 } },
} });
const rich = (input = 10) => ({ timestamp: "2026-09-08T00:00:00Z", type: "token_usage_record", payload: {
  usage: usage(input), thread_token_usage: { input_tokens: input, output_tokens: 5 },
  thread_id: "thread-1", session_id: "session-1", response_id: "response-1", turn_id: "turn-1",
} });
function parse(text: string) {
  const prepared = prepareCodexBytes(Buffer.from(text));
  if (prepared.kind !== "ok") throw new Error(prepared.message);
  return { result: prepared.parse };
}

test("separate provenance preserves existing row contracts, source digest and original complete nested record SHA", () => {
  const text = line(count()), parsed = parse(text);
  const offset = 0;
  expect(parsed.result.events).toEqual([[
    "2026-09-08T00:00:00.000Z", "unknown", "user", "?", "?", "-", 10, 2, 0, 5, 0, null, null,
    "unknown", null, null, offset, "plus", "allowance", null, null, null, null, "token_count", null, "missing", "valid", null,
  ]]);
  expect(parsed.result.rateLimits).toEqual([["2026-09-08T00:00:00.000Z", 300, 12, null, "plus", "?", null, offset, "primary"]]);
  expect(parsed.result.evidence.source).toEqual({ sha256: sha(text), byteLength: Buffer.byteLength(text), scope: "file-prefix" });
  expect(parsed.result.evidence.events[0]).toMatchObject({ sourceOffset: offset, accountingRecord: {
    byteStart: 0, byteEnd: Buffer.byteLength(text), sha256: sha(text),
  }, providerThreadId: null, providerSessionId: null, providerResponseId: null });
  const corrected = parse(line(count(11)));
  expect(corrected.result.evidence.events[0]?.accountingRecord.sha256).not.toBe(parsed.result.evidence.events[0]?.accountingRecord.sha256);
});
test("raw representation and unknown nested fields affect proof hashes without changing stored usage rows", () => {
  const original = count(), nested = { ...original, payload: { ...original.payload, nested_evidence: { opaque: { version: 1 } } } };
  const a = parse(line(original)), b = parse(line(nested));
  expect(b.result.events).toEqual(a.result.events);
  expect(b.result.rateLimits).toEqual(a.result.rateLimits);
  expect(b.result.evidence.events[0]?.accountingRecord.sha256).not.toBe(a.result.evidence.events[0]?.accountingRecord.sha256);
  const spaced = JSON.stringify(original, null, 0).replace('"timestamp":', '"timestamp": ') + "\r\n";
  const c = parse(spaced);
  expect(c.result.events).toEqual(a.result.events);
  expect(c.result.evidence.events[0]?.accountingRecord.sha256).toBe(sha(spaced));
});
test("paired requests carry rich raw-record IDs and framing under the selected legacy event offset", () => {
  const legacyText = line(count()), richText = line(rich());
  const result = parse(legacyText + richText).result;
  expect(result.events.length).toBe(1);
  expect(result.events[0]?.[16]).toBe(0);
  expect(result.events[0]?.[23]).toBe("token_usage_record+token_count");
  expect(result.evidence.events).toEqual([{ sourceOffset: 0,
    accountingRecord: { byteStart: Buffer.byteLength(legacyText), byteEnd: Buffer.byteLength(legacyText + richText), sha256: sha(richText) },
    acceptedEventRecord: { byteStart: 0, byteEnd: Buffer.byteLength(legacyText), sha256: sha(legacyText) },
    providerThreadId: "thread-1", providerSessionId: "session-1", providerResponseId: "response-1", providerTurnId: "turn-1",
    conflictingUsage: false, duplicateRecords: [],
  }]);
});
test("deduplicated rich requests retain selected original bytes and conflicting duplicate proof", () => {
  const original = line(rich()), changed = line(rich(20)), parsed = parse(original + changed);
  expect(parsed.result.events.length).toBe(1);
  expect(parsed.result.events[0]?.[6]).toBe(10);
  expect(parsed.result.events[0]?.[26]).toBe("invalid");
  expect(parsed.result.evidence.events[0]).toMatchObject({ sourceOffset: 0, accountingRecord: { sha256: sha(original) },
    conflictingUsage: true, duplicateRecords: [{ byteStart: Buffer.byteLength(original), byteEnd: Buffer.byteLength(original + changed), sha256: sha(changed) }] });
});
test("conflicting session headers are retained separately and do not invent per-event provider IDs", () => {
  const header = (id: string, forked?: string) => line({ type: "session_meta",
    payload: { id, originator: "codex-tui", thread_source: "user", ...(forked ? { forked_from_id: forked } : {}) } });
  // A forked thread names its parent in its header (the ledger resolves the parent's calls it replays).
  const a = header("session-a", "parent-thread"), b = header("session-b"), parsed = parse(a + b + line(count()));
  expect(parsed.result.evidence.sessionHeaders).toEqual([
    { sourceOffset: 0, byteStart: 0, byteEnd: Buffer.byteLength(a), sha256: sha(a), providerSessionId: "session-a", providerForkedFromId: "parent-thread" },
    { sourceOffset: Buffer.byteLength(a), byteStart: Buffer.byteLength(a), byteEnd: Buffer.byteLength(a + b), sha256: sha(b),
      providerSessionId: "session-b", providerForkedFromId: null },
  ]);
  expect(parsed.result.evidence.events[0]).toMatchObject({ providerSessionId: null, providerThreadId: null, providerResponseId: null });
});
test("full file preparation hashes ignored/non-accounting bytes and incomplete tail, safely through the worker pool", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provenance-")), file = path.join(directory, "synthetic.jsonl");
  const pool = new ParsePool(1);
  try {
    const text = line({ type: "response_item", payload: { message: "not retained" } }) + line(rich()) + '{"partial":';
    fs.writeFileSync(file, text);
    const direct = prepareCodexFixture(file, Buffer.byteLength(text));
    expect(direct.kind).toBe("ok"); if (direct.kind !== "ok") throw new Error("parse failed");
    expect(direct.parse.evidence.source).toEqual({ sha256: sha(text), byteLength: Buffer.byteLength(text), scope: "file-prefix" });
    expect(direct.parse.events.length).toBe(1);
    const pooled = await pool.run("codex", { file, size: Buffer.byteLength(text) });
    expect(pooled).toEqual(direct);
    expect(JSON.stringify(pooled)).not.toContain("not retained");
  } finally { await pool.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
