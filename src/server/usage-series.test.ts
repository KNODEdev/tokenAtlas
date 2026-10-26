import { describe, expect, it } from "bun:test";
import { cycleElapsedMs } from "./api";

describe("cycleElapsedMs", () => {
  it("uses the early replacement boundary for a historical weekly window", () => {
    const start = Date.parse("2026-08-25T14:00:00.000Z");
    const lastSample = Date.parse("2026-08-27T15:42:00.000Z");
    const replacement = Date.parse("2026-08-27T16:00:00.000Z");

    expect(cycleElapsedMs(false, start, lastSample, replacement)).toBe(50 * 3_600_000);
  });

  it("continues to use current time for an active window", () => {
    const start = Date.parse("2026-08-25T14:00:00.000Z");
    const now = Date.parse("2026-08-27T16:00:00.000Z");
    const scheduledReset = Date.parse("2026-09-01T14:00:00.000Z");

    expect(cycleElapsedMs(true, start, now, scheduledReset)).toBe(50 * 3_600_000);
  });
});
