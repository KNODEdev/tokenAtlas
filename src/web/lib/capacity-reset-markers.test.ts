import { expect, test } from "bun:test";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import { alignProviderResetMarkers } from "./capacity-reset-markers";
import { markerTimestamp, markerUtcLabel } from "../components/CapacityAnnotations";
import { setLanguage } from "./i18n";

const window = (id: string, start: string, reset: string, basis: Window["start_basis"] = "reset"): Window => ({
  id, account: "codex1", plan: "pro", start, end: reset, reset, cycle_start: start, start_basis: basis,
  start_percent: 0, end_percent: 80, observed_pp: 80, probes: 10, max_gap_hours: 0, sources: [], models: [],
  usage: { events: 0, unpriced_events: 0, tokens: 0, input: 0, cached: 0, output: 0, fast_tokens: 0, unknown_tokens: 0,
    priced_tokens: 0, api_standard: 0, credits_low: 0, credits_high: 0 },
});
const reset = (at: string, id = "reset:global"): TimelineMarker => ({ id, day: at.slice(0, 10), observed_at: at,
  label: "Global reset", note: "Public confirmation", color: "crit", visible: true });

test("September resets follow the observed zero boundary, not later same-day cycles or the public post", () => {
  setLanguage("en");
  const september8 = window("sep8-reset", "2026-09-08T01:21:49Z", "2026-09-15T01:21:49Z");
  const laterBanked = window("sep8-later", "2026-09-08T21:06:19Z", "2026-09-15T21:06:19Z");
  const september12 = window("sep12-reset", "2026-09-12T08:10:13Z", "2026-09-19T08:10:13Z");
  const sampleSplit = window("sep12-split", "2026-09-12T09:48:49Z", september12.reset, "zero_reading");
  const points = [reset("2026-09-08T01:56:00Z", "reset:sep8"), reset("2026-09-12T08:09:00Z", "reset:sep12")];
  const original = JSON.stringify(points);
  const aligned = alignProviderResetMarkers(points, [september8, laterBanked, september12, sampleSplit]);
  expect(aligned.map(point => point.reset_boundary?.cycle_id)).toEqual([september8.id, september12.id]);
  expect(aligned.map(markerTimestamp)).toEqual([Date.parse(september8.cycle_start!), Date.parse(september12.cycle_start!)]);
  expect(markerUtcLabel(aligned[0]!)).toContain("2026-09-08 01:56:00 UTC");
  expect(markerUtcLabel(aligned[0]!)).toContain("2026-09-08 01:21:49 UTC");
  expect(JSON.stringify(points)).toBe(original);
  // Even a confirmation nearer the same-reset sample split must not create a second reset.
  expect(alignProviderResetMarkers([reset("2026-09-12T09:48:00Z")], [september12, sampleSplit])[0]!.reset_boundary?.cycle_id).toBe(september12.id);
});

test("partial/manual samples and distant windows never become observed reset boundaries", () => {
  const point = reset("2026-09-26T18:17:00Z");
  const real = window("real", "2026-09-26T16:58:00Z", "2026-10-03T16:58:00Z");
  const partial = { ...window("partial", "2026-09-26T18:16:00Z", real.reset, "partial"), start_percent: 20 };
  expect(alignProviderResetMarkers([point], [real, partial])[0]!.reset_boundary?.cycle_id).toBe(real.id);
  expect(alignProviderResetMarkers([point], [partial])[0]!.reset_boundary).toBeNull();
  expect(alignProviderResetMarkers([point], [{ ...real, manual_measurement: { id: "manual", approximate_time: false, note: "" } }])[0]!.reset_boundary).toBeNull();
  const aligned = alignProviderResetMarkers([point], [real]);
  expect(alignProviderResetMarkers(aligned, [window("far", "2026-09-01T00:00:00Z", real.reset)])[0]!.reset_boundary).toBeNull();
  expect(alignProviderResetMarkers([point, { ...point, id: "reset:duplicate" }], [real]).filter(marker => marker.reset_boundary)).toHaveLength(1);
});
