import { describe, expect, it } from "bun:test";
import { navStatus } from "./nav-status";

const NOW = Date.parse("2026-11-14T22:00:00.000Z");
const none = { lastSync: null, calls: null, live: false };

describe("menu status foot", () => {
  it("keeps the selected subscription's samples when it has a series", () => {
    const series = { lastSync: "2026-11-14T21:57:00.000Z", calls: 1_050_112, live: true };
    expect(navStatus(series, true, { running: false, finished_at: null, ok: null }, NOW)).toEqual({ ...series, basis: "series" });
  });
  it("reports the last synchronization for a selection without a series", () => {
    expect(navStatus(none, false, { running: false, finished_at: "2026-11-14T21:31:00.000Z", ok: true }, NOW))
      .toEqual({ lastSync: "2026-11-14T21:31:00.000Z", calls: null, live: true, basis: "sync" });
  });
  it("is live while a synchronization runs, stale after six hours or a failed run", () => {
    expect(navStatus(none, false, { running: true, finished_at: null, ok: null }, NOW).live).toBe(true);
    expect(navStatus(none, false, { running: false, finished_at: "2026-11-14T15:00:00.000Z", ok: true }, NOW).live).toBe(false);
    expect(navStatus(none, false, { running: false, finished_at: "2026-11-14T21:31:00.000Z", ok: false }, NOW).live).toBe(false);
  });
  it("does not claim stale data before the state is known", () => {
    expect(navStatus(none, false, null, NOW)).toEqual({ lastSync: null, calls: null, live: null, basis: "sync" });
  });
});
