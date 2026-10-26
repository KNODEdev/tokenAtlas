import { describe, expect, it } from "bun:test";
import { buildPeriodIndex, observedPeriods, planActivityAt, validatePeriods, type DatedPeriod, type PeriodReading } from "./account-periods";

const reading = (ts: string, value: string, subject = "claude/PC"): PeriodReading => ({ provider: "claude", subject, ts, value });
const declared = (from: string, until: string | null, value: string, subject = "claude/PC"): DatedPeriod => ({
  provider: "claude", subject, from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "owner-declaration",
});

describe("observedPeriods", () => {
  it("keeps one row for an unbroken account across a long silence", () => {
    const periods = observedPeriods([
      reading("2026-09-09T15:48:00.000Z", "a"), reading("2026-09-09T15:53:00.000Z", "a"), reading("2026-09-12T13:41:00.000Z", "a"),
    ]);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ from: "2026-09-09T15:48:00.000Z", until: null, lastSeen: "2026-09-12T13:41:00.000Z", readings: 3 });
  });

  it("closes a period at its last reading and leaves the time before the next account to nobody", () => {
    const periods = observedPeriods([
      reading("2026-07-08T14:43:00.000Z", "old"), reading("2026-07-29T09:54:00.000Z", "new"), reading("2026-07-08T14:40:00.000Z", "old"),
    ]);
    expect(periods.map((p) => [p.value, p.from, p.until])).toEqual([
      ["old", "2026-07-08T14:40:00.000Z", "2026-07-08T14:43:00.001Z"],
      ["new", "2026-07-29T09:54:00.000Z", null],
    ]);
    const index = buildPeriodIndex(periods);
    expect(index.resolve("claude", "claude/PC", "2026-07-20T12:00:00.000Z")).toEqual({ value: null, basis: "gap", period: null });
    expect(index.resolve("claude", "claude/PC", "2026-01-10T00:00:00.000Z").basis).toBe("uncovered");
    expect(index.resolve("claude", "claude/PC", "2026-08-01T00:00:00.000Z").value).toBe("new");
    // A closed period still owns its last reading, also when that was its only one.
    expect(index.resolve("claude", "claude/PC", "2026-07-08T14:43:00.000Z").value).toBe("old");
    expect(observedPeriods([reading("2026-07-08T14:43:00.000Z", "once"), reading("2026-07-29T09:54:00.000Z", "new")])[0]!.until).toBe("2026-07-08T14:43:00.001Z");
  });

  it("never joins readings of two sources", () => {
    const periods = observedPeriods([reading("2026-09-01T00:00:00.000Z", "a"), reading("2026-09-01T00:01:00.000Z", "b", "claude/LAPTOP")]);
    expect(periods.map((p) => [p.subject, p.value, p.until])).toEqual([["claude/LAPTOP", "b", null], ["claude/PC", "a", null]]);
  });
});

describe("buildPeriodIndex", () => {
  const observed = observedPeriods([reading("2026-09-09T15:48:00.000Z", "seen"), reading("2026-09-10T00:00:00.000Z", "seen")]);

  it("prefers the session identity, then a declared period, then an observed one", () => {
    const index = buildPeriodIndex([...observed, declared("2026-09-09", "2026-09-10", "corrected")]);
    expect(index.resolve("claude", "claude/PC", "2026-09-09T16:00:00.000Z", "from-session")).toMatchObject({ value: "from-session", basis: "direct" });
    expect(index.resolve("claude", "claude/PC", "2026-09-09T16:00:00.000Z")).toMatchObject({ value: "corrected", basis: "declared" });
    expect(index.resolve("claude", "claude/PC", "2026-09-10T00:00:00.000Z")).toMatchObject({ value: "seen", basis: "observed" });
  });

  it("treats a declared day as its UTC midnight, start inclusive and end exclusive", () => {
    const index = buildPeriodIndex([declared("2026-01-09", "2026-03-29", "paid")]);
    expect(index.resolve("anthropic", "CLAUDE/pc", "2026-01-09T00:00:00.000Z").value).toBe("paid");
    expect(index.resolve("claude", "claude/PC", "2026-03-28T22:42:00.000Z").value).toBe("paid");
    expect(index.resolve("claude", "claude/PC", "2026-03-29T00:00:00.000Z").value).toBeNull();
  });

  it("rejects overlapping periods of one origin and an inverted interval", () => {
    expect(validatePeriods([declared("2026-01-01", "2026-03-01", "a"), declared("2026-02-01", null, "b")])).toHaveLength(1);
    expect(validatePeriods([declared("2026-01-01", "2026-03-01", "a"), declared("2026-02-01", null, "b", "claude/LAPTOP")])).toEqual([]);
    expect(validatePeriods([declared("2026-03-01", "2026-03-01", "a")])).toHaveLength(1);
    expect(() => buildPeriodIndex([declared("bad", null, "a")])).toThrow();
  });
});

describe("planActivityAt", () => {
  const observedPlan = (from: string, value: string, subject: string): DatedPeriod => ({
    provider: "claude", subject, from, until: null, value, origin: "observed", firstSeen: from, lastSeen: from, readings: 1, evidence: "profile-reading",
  });
  const now = "2026-09-22T12:00:00.000Z";
  it("ends a subscription whose declared plan closed an observed run of the same plan", () => {
    const active = planActivityAt([
      observedPlan("2026-09-09T10:43:00.000Z", "default_claude_ai", "ended"), declared("2026-09-08", "2026-09-18", "pro", "ended"),
      observedPlan("2026-09-21T19:41:00.000Z", "default_claude_max_5x", "live"),
      declared("2026-02-28", "2026-03-28", "max-20x", "history"),
    ], now);
    expect(active("claude", "ended")).toBe(false);
    expect(active("claude", "live")).toBe(true);
    expect(active("claude", "history")).toBe(false);
    // No plan history says nothing; the caller keeps its own signal.
    expect(active("claude", "unknown")).toBeNull();
  });
});
