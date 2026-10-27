import { expect, test } from "bun:test";
import { publicCapacityEvents, publicCompare, publicProjects, publicWindowCompare } from "./howto-home";

test("projects are ranked and anonymous: no name, path or id reaches the output", () => {
  const subject = (name: string, usd: number, kind = "project") => ({ subject: name, kind, api_usd: usd });
  const result = publicProjects(
    { subjects: [subject("C:/Users/PRIVATE/secret-repo", 5), subject("client-acme", 1), subject("other", 2)] },
    { subjects: [subject("C:/Users/PRIVATE/secret-repo", 40), subject("client-acme", 10), subject("other", 25), subject("small", 5), subject("repo-row", 999, "repo")] });
  expect(result.top).toEqual([{ rank: 1, week: 5, month: 40 }, { rank: 2, week: 2, month: 25 }, { rank: 3, week: 1, month: 10 }]);
  expect(result.projectCount).toBe(4);
  expect(result.topShareOfMonth).toBe(93.8);
  const text = JSON.stringify(result);
  for (const sentinel of ["PRIVATE", "secret", "acme", "other", "repo"]) expect(text).not.toContain(sentinel);
});

test("the compare instrument is null, not zero, when the account has no current weekly window", () => {
  expect(publicCompare({ account: "x", provider: "codex", source: "probe", windows: [] } as never, Date.now(), "A")).toBeNull();
});

test("the window comparison is null, not empty, without a weekly window, and publishes no machine or traffic", () => {
  expect(publicWindowCompare({ account: "x", provider: "claude", source: "probe", windows: [] } as never, Date.now(), "A")).toBeNull();
  const start = Date.parse("2026-10-01T00:00:00Z"), hour = 3_600_000;
  const window = (key: string, weeksAgo: number, used: number, isCurrent = false) => ({
    key, counterKey: "claude:7d", counterLabel: "7d", label: "7d", dateLabel: "", source: "probe", isCurrent, usedPercent: used, percentBasis: "measured",
    elapsedPercent: isCurrent ? 50 : 100, ppAhead: null, windowHours: 168, regimeKey: "claude:7d:max-20x",
    startIso: new Date(start - weeksAgo * 168 * hour).toISOString(), resetIso: new Date(start - (weeksAgo - 1) * 168 * hour).toISOString(),
    shape: [{ t: 0, pct: 0 }, { t: 50, pct: used / 2 }, { t: isCurrent ? 50 : 100, pct: isCurrent ? used : used }], sublimits: [],
    sampleMachine: "PRIVATE-LAPTOP", trafficByMachine: [{ machine: "PRIVATE-LAPTOP", share: 1 }], tokensTotal: 1, usd: 1, note: null, scope: null,
  });
  const rows = [window("now", 0, 30, true), window("w1", 1, 60), window("w2", 2, 80), window("w3", 3, 70)];
  const result = publicWindowCompare({ account: "x", provider: "claude", source: "probe", windows: rows } as never, start + 84 * hour, "B")!;
  expect(result.current).toMatchObject({ usedPercent: 30, exact: true });
  expect(result.closed.map(item => item.usedPercent)).toEqual([60, 80, 70]);
  expect(result.closed.every(item => item.comparable)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("the capacity events are the shipped public catalogs up to now, in time order, each with its kind", () => {
  const now = Date.parse("2026-10-27T20:00:00Z");
  const events = publicCapacityEvents(now);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(event => Date.parse(event.at) <= now)).toBe(true);
  expect(events.map(event => Date.parse(event.at))).toEqual(events.map(event => Date.parse(event.at)).sort((a, b) => a - b));
  // Announcements are Codex's catalog and carry both titles; resets carry none and only their source.
  for (const event of events) {
    if (event.kind === "reset") { expect(event.title).toBeNull(); expect(event.source).toMatch(/^https:\/\//); }
    else { expect(event.provider).toBe("codex"); expect(event.title!.en.length).toBeGreaterThan(0); expect(event.title!.pl.length).toBeGreaterThan(0); }
  }
  expect(events.some(event => event.id === "promotion:codex-pro-200-usage-cut-20260929:announcement" && event.kind === "policy")).toBe(true);
  // Nothing from after the export moment.
  expect(publicCapacityEvents(Date.parse("2026-01-01T00:00:00Z")).every(event => Date.parse(event.at) <= Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
});
