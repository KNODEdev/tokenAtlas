import { expect, test } from "bun:test";
import { modelUsageShare } from "./model-usage-share";

const H = 3_600_000, start = Date.parse("2026-10-01T00:00:00Z");
const at = (hour: number) => start + hour * H;
const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

test("each hour's meter increase follows that hour's API shares and the window totals stay exact", () => {
  const points = modelUsageShare({ start, end: at(168), stop: at(3),
    meter: [[at(0), 4], [at(1), 10], [at(2), 10]],
    models: [{ api_usd: 30, hours: [[at(0), 100], [at(1), 200]] }, { api_usd: 10, hours: [[at(0), 100]] }] });
  expect(points).toHaveLength(4);
  // Hour 0: A $10, B $10 → 4 pp split evenly; hour 1: only A → 6 pp to A.
  expect(points[1]!.pct).toEqual([2, 2]);
  expect(points[2]!.pct).toEqual([8, 2]);
  expect(points.at(-1)!).toMatchObject({ meter: 10, api_usd: [30, 10], unattributed: 0 });
  expect(total(points.at(-1)!.pct)).toBe(10);
});

test("an increase without traffic in its hour uses the preceding hours, then the window so far, else stays unattributed", () => {
  const lagged = modelUsageShare({ start, end: at(10), stop: at(3), meter: [[at(1), 5]],
    models: [{ api_usd: 6, hours: [[at(0), 1]] }, { api_usd: 0, hours: [[at(1), 50]] }] });
  expect(lagged.at(-1)!.pct).toEqual([5, 0]);
  const late = modelUsageShare({ start, end: at(10), stop: at(6), meter: [[at(5), 3]],
    models: [{ api_usd: 2, hours: [[at(0), 1]] }, { api_usd: 6, hours: [[at(1), 1]] }] });
  expect(late.at(-1)!.pct).toEqual([0.75, 2.25]);
  const unpriced = modelUsageShare({ start, end: at(10), stop: at(2), meter: [[at(0), 7]],
    models: [{ api_usd: 0, hours: [[at(0), 900]] }] });
  expect(unpriced.at(-1)!).toMatchObject({ pct: [0], unattributed: 7, meter: 7 });
});

test("a window starts at 0%, and readings never move the meter down", () => {
  const points = modelUsageShare({ start: at(0) + 20 * 60_000, end: at(10), stop: at(2),
    meter: [[at(0), 3], [at(1), 2]], models: [{ api_usd: 1, hours: [[at(0), 1]] }] });
  expect(points.map(point => point.meter)).toEqual([0, 3, 3]);
  expect(points.at(-1)!.pct).toEqual([3]);
});

test("a current window extended later keeps every earlier point (incremental equals full)", () => {
  const input = { start, end: at(48), meter: [[at(0), 1], [at(2), 4], [at(5), 9]] as Array<[number, number]>,
    models: [{ api_usd: 12, hours: [[at(0), 3], [at(2), 1], [at(5), 2]] as Array<[number, number]> }, { api_usd: 4, hours: [[at(2), 2]] as Array<[number, number]> }] };
  const full = modelUsageShare({ ...input, stop: at(6) });
  // Earlier stored sums hold only the hours so far, with the API value of those hours (both models: $2 per token).
  const partial = modelUsageShare({ ...input, stop: at(3), models: input.models.map(model => {
    const hours = model.hours.filter(([hour]) => hour < at(3));
    return { api_usd: 2 * hours.reduce((sum, [, tokens]) => sum + tokens, 0), hours };
  }) });
  expect(partial.map(point => point.pct)).toEqual(full.slice(0, partial.length).map(point => point.pct));
  expect(modelUsageShare({ ...input, stop: at(6) })).toEqual(full);
});
