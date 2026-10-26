import { expect, test } from "bun:test";
import { endPercentAt, exhaustionIn, laneOf, laneSegments, percentAt, suggestLane, type LaneCard } from "./window-lanes";

const card = (over: Partial<LaneCard>): LaneCard => ({
  id: "a", plan: "pro", spent: false, usedPercent: 10, elapsedPercent: 10, remainingHours: 151.2, projectedEndPercent: null, ...over,
});

test("a lane recovers the window length and the pace from the card", () => {
  const lane = laneOf(card({ usedPercent: 19, elapsedPercent: 10, remainingHours: 151.2 }), 168)!;
  expect(lane.windowHours).toBeCloseTo(168);
  expect(lane.ratePerHour).toBeCloseTo(19 / 16.8);
  expect(laneOf(card({ remainingHours: null }), 168)).toBeNull();
});

test("the card's own projection sets the pace when it has one", () => {
  const lane = laneOf(card({ usedPercent: 20, remainingHours: 100, projectedEndPercent: 70 }), 168)!;
  expect(lane.ratePerHour).toBeCloseTo(0.5);
  expect(endPercentAt(lane, 0)).toBeCloseTo(70);
  expect(exhaustionIn(lane, 0)).toBeNull();
});

test("a fast window runs out before its reset and opens again after it", () => {
  const lane = laneOf(card({ usedPercent: 50, elapsedPercent: 25, remainingHours: 126 }), 168)!;
  const { segments, resets } = laneSegments(lane, 168);
  expect(resets).toEqual([126]);
  expect(segments.map(s => s.state)).toEqual(["open", "spent", "open"]);
  // 50% in 42 h: the other half lasts another 42 h.
  expect(segments[0]!.to).toBeCloseTo(42);
  expect(percentAt(lane, 130)).toBeCloseTo(lane.ratePerHour * 4);
});

test("an exhausted window stays spent until its reset", () => {
  const lane = laneOf(card({ spent: true, usedPercent: 100, elapsedPercent: 60, remainingHours: 10 }), 168)!;
  expect(laneSegments(lane, 24).segments[0]).toEqual({ from: 0, to: 10, state: "spent" });
});

test("the suggestion is the paid window that loses most per hour to its reset", () => {
  const lanes = [
    laneOf(card({ id: "slow", usedPercent: 8, elapsedPercent: 10, remainingHours: 151.2 }), 168)!,
    laneOf(card({ id: "near", usedPercent: 40, elapsedPercent: 90, remainingHours: 16.8 }), 168)!,
    laneOf(card({ id: "free", plan: "free", usedPercent: 0, elapsedPercent: 50, remainingHours: 2 }), 168)!,
    laneOf(card({ id: "fast", usedPercent: 91, elapsedPercent: 55, remainingHours: 75.6 }), 168)!,
  ];
  const pick = suggestLane(lanes, 0)!;
  expect(pick.id).toBe("near");
  expect(pick.lostPercent).toBeCloseTo(100 - 40 / 0.9);
  expect(suggestLane([lanes[3]!], 0)).toBeNull();
});
