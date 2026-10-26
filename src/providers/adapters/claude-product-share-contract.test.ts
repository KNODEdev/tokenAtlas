import { expect, test } from "bun:test";
import { CLAUDE_RAW_USAGE_PREFIX, claudeProbeAdapter } from "./claude";

const reset = "2026-09-20T10:59:59.225126+00:00";
const breakdown = {
  as_of: "2026-09-17T00:06:36.239074+00:00",
  window_started_at: "2026-09-13T10:59:59.225126+00:00",
  rows: [{ key: "claude_code", display_name: "Claude Code", percent: 12 }],
};
const limit = { kind: "weekly_all", group: "weekly", percent: 24, resets_at: reset };
// Raw account meters ride on the weekly bar by design; only product evidence is under test.
const withoutRaw = (extra: Record<string, unknown> | null) =>
  Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => !key.startsWith(CLAUDE_RAW_USAGE_PREFIX)));

test("Claude product evidence belongs to the exact weekly window", () => {
  const parsed = claudeProbeAdapter.parse({ plan: "max", usage: {
    seven_day: { utilization: 24, resets_at: reset },
    seven_day_breakdown: { ...breakdown, window_started_at: "2026-09-06T10:59:59.225126+00:00" },
  } });
  expect(parsed.readings).toHaveLength(1);
  expect(withoutRaw(parsed.readings[0]!.extra)).toEqual({ severity: null, is_active: false });
});

for (const scope of [{ model: { id: "scoped-model", display_name: null } }, { surface: "claude_code" }]) {
  test(`Claude product evidence cannot attach to a scoped weekly limit: ${JSON.stringify(scope)}`, () => {
    const parsed = claudeProbeAdapter.parse({ plan: "max", usage: {
      limits: [{ ...limit, scope }], seven_day_breakdown: breakdown,
    } });
    expect(parsed.readings).toHaveLength(1);
    expect(withoutRaw(parsed.readings[0]!.extra)).toEqual({ severity: null, is_active: false });
  });
}

test("conflicting modern and legacy account windows do not bind product evidence", () => {
  const parsed = claudeProbeAdapter.parse({ plan: "max", usage: {
    limits: [limit],
    seven_day: { utilization: 24, resets_at: "2026-09-21T10:59:59.225126+00:00" },
    seven_day_breakdown: breakdown,
  } });
  expect(parsed.readings).toHaveLength(1);
  expect(parsed.readings[0]!.usedPercent).toBe(24);
  expect(withoutRaw(parsed.readings[0]!.extra)).toEqual({ severity: null, is_active: false });
});
