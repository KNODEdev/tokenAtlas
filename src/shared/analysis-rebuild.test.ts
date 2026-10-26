import { expect, test } from "bun:test";
import { parseRebuildOptions, rebuildTimeBounds, REBUILD_DAYS, resolveRebuildRange, type RebuildScope } from "./analysis-rebuild";

test("vendor selection is explicit, canonical and never turns malformed input into all vendors", () => {
  expect(parseRebuildOptions({scope:"all",vendors:["claude","codex"]})).toEqual({
    scope:"all",mode:"archive",vendors:["codex","claude"],
  });
  expect(parseRebuildOptions({scope:"custom",from:"2026-09-01",until:"2026-09-02",vendors:["gauges"]}))
    .toEqual({scope:"custom",mode:"archive",from:"2026-09-01",until:"2026-09-02",vendors:["gauges"]});
  for (const vendors of [null,[],"claude",{},["unknown"],["Claude"],["claude",null],[""],[1],["claude","claude"]])
    expect(() => parseRebuildOptions({scope:"all",vendors})).toThrow();
  expect(parseRebuildOptions({scope:"all"})).not.toHaveProperty("vendors");
});

test("all supported rolling periods include today in UTC and persist exact day bounds", () => {
  const now = new Date("2026-01-01T00:01:00Z");
  for (const days of REBUILD_DAYS) {
    const range = resolveRebuildRange({scope:`${days}d`}, now)!;
    expect(range.until).toBe("2026-01-01");
    const bounds = rebuildTimeBounds(range);
    expect((Date.parse(bounds.untilExclusive)-Date.parse(bounds.from))/86_400_000).toBe(days);
  }
  for (const [scope,days] of [["week",7],["month",30]] as const)
    expect(resolveRebuildRange({scope},now)).toEqual(resolveRebuildRange({scope:`${days}d`},now));
  expect(resolveRebuildRange({scope:"all"},now)).toBeNull();
});

test("custom calendar days use a half-open interval including fractional final seconds", () => {
  const options = parseRebuildOptions({scope:"custom",from:"2024-02-29",until:"2024-02-29"});
  expect(options.mode).toBe("archive");
  const range = resolveRebuildRange(options,new Date("2026-09-16"))!;
  expect(rebuildTimeBounds(range)).toEqual({from:"2024-02-29T00:00:00.000Z",untilExclusive:"2024-03-01T00:00:00.000Z"});
  expect(resolveRebuildRange(options,new Date("2027-10-01"))).toEqual(range);
});

test("invalid or ambiguous date and mode inputs never start a reset", () => {
  for (const input of [null, [], {scope:"2d"}, {scope:7}, {scope:"custom",from:"2025-02-29",until:"2025-03-01"},
    {scope:"custom",from:"2026-09-17",until:"2026-09-16"}, {scope:"custom",from:"2026-09-16T00:00:00Z",until:"2026-09-17"},
    {scope:"week",from:"2026-09-01"}, {scope:"all",mode:"full"}, {scope:"custom",from:"2026-01-01",until:"9999-12-31"}])
    expect(()=>parseRebuildOptions(input)).toThrow();
  expect(parseRebuildOptions({scope:"all",mode:"collect-archive"})).toEqual({scope:"all",mode:"collect-archive"});
});
