import { expect, test } from "bun:test";
import { codexFirstTokenAdapter as adapter } from "./codex";
import { FIRST_TOKEN_UNAVAILABLE, firstTokenAdapters } from "./index";

export function turn(id = "turn-a", ms: unknown = 2000, model = "test-model", at = "2026-10-25T10:00:00.000Z") {
  const timestamp = new Date(Date.parse(at) + 10_000).toISOString();
  return [
    { type: "turn_context", payload: { turn_id: id, model } },
    { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: id } },
    { type: "event_msg", timestamp, payload: { type: "task_complete", turn_id: id, time_to_first_token_ms: ms, duration_ms: 10_000 } },
  ];
}
test("reported TTFT belongs once to the matching completed turn and model", () => {
  const a = turn(), b = turn("turn-b", 3000, "other-model");
  expect(adapter.parse([...a.slice(0, 2), ...b.slice(0, 2), a[2], a[2], b[2]])).toEqual([
    { id: "turn-a", model: "test-model", ts: "2026-10-25T10:00:00.000Z", ms: 2000, billing: "unknown", reason: null },
    { id: "turn-b", model: "other-model", ts: "2026-10-25T10:00:00.000Z", ms: 3000, billing: "unknown", reason: null },
  ]);
});
test("missing, invalid, aborted and unmatched evidence never invents a measurement", () => {
  for (const ms of [null, -1, 1.5, "42", true, 11_001, Number.MAX_SAFE_INTEGER + 1])
    expect(adapter.parse(turn("t", ms))[0]!.ms).toBeNull();
  expect(adapter.parse(turn("t", 0))[0]!.ms).toBe(0);
  expect(adapter.parse(turn().slice(0, 2))).toEqual([]);
  expect(adapter.parse(turn().slice(2))).toEqual([]);
  expect(adapter.parse([turn()[1], turn()[2]])[0]!.model).toBeNull();
  expect(adapter.parse([...turn(), turn("turn-a", 4000)[2]])[0]).toMatchObject({ ms: null, reason: "conflicting_completion" });
});
test("business evidence follows its own turn; Grok stream timestamps remain unverified", () => {
  const rows = turn();
  expect(adapter.parse([...rows.slice(0, 2), { type: "event_msg", payload: { type: "token_count", rate_limits: { plan_type: "self_serve_business_usage_based" } } }, rows[2]])[0]!.billing)
    .toBe("business_credits");
  expect(firstTokenAdapters.find(a => a.id === "grok")).toBeUndefined();
  expect(FIRST_TOKEN_UNAVAILABLE.grok).toBe("unverified_stream_timestamps");
});
