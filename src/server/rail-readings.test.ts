import { describe, expect, it } from "bun:test";
import { addLimitHitReadings, type LimitHit, type RailGroup, type RailSample } from "./rail-readings";

const HOUR = 3_600_000;
const RESET = "2026-09-27T11:00:00.000Z";
const START = Date.parse(RESET) - 168 * HOUR;
const at = (hours: number) => new Date(START + hours * HOUR).toISOString();
const sample = (hours: number, used: number): RailSample => ({ id: hours, ts: at(hours), kind: "weekly_all", limit_group: "weekly",
  scope: null, used_percent: used, remaining_percent: null, vendor_percent: used, window_minutes: null, resets_at: RESET, machine: "PC", extra: "{}" });
const weekly = (samples: RailSample[]): RailGroup<RailSample> =>
  ({ kind: "weekly_all", limitGroup: "weekly", scope: null, resetIso: RESET, unstarted: false, samples });
describe("limit refusals on the rail", () => {
  // Reset instants of one window differ by a fraction of a second between readings.
  const sameReset = (left: string | null, right: string | null) =>
    left != null && right != null && Math.abs(Date.parse(left) - Date.parse(right)) <= 120_000;
  const hit = (hours: number, patch: Partial<LimitHit> = {}): LimitHit =>
    ({ callId: `c${hours}`, ts: at(hours), limitType: "seven_day", resetsAt: "2026-09-27T11:00:00.319Z", ...patch });
  const template = (h: LimitHit, counter: { kind: string; limitGroup: string; minutes: number }): RailSample =>
    ({ ...sample(0, 100), ts: h.ts, kind: counter.kind, limit_group: counter.limitGroup, window_minutes: counter.minutes, resets_at: h.resetsAt, machine: null });
  const addHits = (groups: RailGroup<RailSample>[], hits: LimitHit[]) => addLimitHitReadings(groups, hits, sameReset, template);

  it("adds the refusal as 100% of the window with the vendor's reset, once per call", () => {
    const group = weekly([sample(10, 25), sample(77, 88), sample(95, 0)]);
    addHits([group], [hit(82.8), hit(82.8), hit(82.9, { callId: "c-retry" })]);
    expect(group.samples.map((row) => [row.used_percent, row.limitHit?.callId ?? null]))
      .toEqual([[25, null], [88, null], [100, "c82.8"], [100, "c-retry"], [0, null]]);
  });

  it("starts a window of its own when no account reading of that reset exists", () => {
    const groups = [weekly([sample(10, 25)])];
    addHits(groups, [hit(20, { limitType: "five_hour", resetsAt: at(22) })]);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ kind: "session", limitGroup: "session", scope: null, resetIso: at(22) });
    expect(groups[1]!.samples).toEqual([expect.objectContaining({ ts: at(20), used_percent: 100, window_minutes: 300, limitHit: { callId: "c20" } })]);
  });

  it("leaves out refusals that contradict the account, name no counter or come after their reset", () => {
    const group = weekly([sample(10, 40), sample(60, 70), sample(80, 88)]);
    addHits([group], [hit(65), hit(30, { limitType: "seven_day_opus" }), hit(200)]);
    expect(group.samples.some((row) => row.limitHit)).toBe(false);
  });
});
