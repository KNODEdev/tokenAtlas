import { expect, test } from "bun:test";
import { ResetProbeWatch } from "./reset-probe";

const RESET = Date.parse("2026-10-11T11:00:00.000Z");
const subject = (resets: string) => [{ provider: "claude", subject: "claude-a", limits: [{ resets_at: resets }, { resets_at: "2026-10-18T11:00:00.000Z" }] }];

test("a reset that just passed is read again shortly after it, a few times at most", () => {
  const watch = new ResetProbeWatch();
  const limits = subject("2026-10-11T11:00:00.252154+00:00");
  expect(watch.due(limits, RESET - 60_000)).toEqual([]);
  expect(watch.due(limits, RESET + 10_000)).toEqual([]);
  expect(watch.due(limits, RESET + 31_000)).toEqual([{ provider: "claude", subject: "claude-a" }]);
  // Not again before the retry gap; then twice more and no further.
  expect(watch.due(limits, RESET + 60_000)).toEqual([]);
  expect(watch.due(limits, RESET + 130_000)).toHaveLength(1);
  expect(watch.due(limits, RESET + 230_000)).toHaveLength(1);
  expect(watch.due(limits, RESET + 330_000)).toEqual([]);
});

test("a reading after the reset, or a reset long past, starts no read", () => {
  const watch = new ResetProbeWatch();
  expect(watch.due(subject("2026-10-18T11:00:00.405Z"), RESET + 60_000)).toEqual([]);
  expect(watch.due(subject("2026-10-11T11:00:00.000Z"), RESET + 20 * 60_000)).toEqual([]);
});
