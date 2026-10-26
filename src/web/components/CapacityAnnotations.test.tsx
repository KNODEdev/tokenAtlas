import { expect, test } from "bun:test";
import type { TimelineMarker, TimelineMarkersResponse } from "../../shared/codex-accounting";
import { capacityMarkers, isPolicyMarker, isPromotionMarker, isProviderResetMarker, markerDisplayLabel, markerKindLabel, markerTimestamp, markerUtcLabel } from "./CapacityAnnotations";
import { setLanguage } from "../lib/i18n";

const now = Date.parse("2026-10-20T07:00:00Z");

test("Pro usage cut is a timed policy announcement, not an account transition or promotion end", () => {
  setLanguage("en");
  const id = "promotion:codex-pro-200-usage-cut-20260929:announcement";
  const at = Date.parse("2026-09-29T06:41:17Z");
  expect(capacityMarkers(null, "2026-09-29", "2026-09-29", "codex", at - 1).some(m => m.id === id)).toBe(false);
  const markers = capacityMarkers(null, "2026-09-29", "2026-09-30", "codex", now);
  const policy = markers.find(m => m.id === id)!;
  expect(isPolicyMarker(policy)).toBe(true);
  expect(policy.label).toContain("Plan change announced · Pro $200: 20× → 10×");
  expect(policy.note).toContain("15:10:31 UTC");
  expect(policy.note).toContain("keep the 20X multiplier for a bit");
  expect(policy.note).toContain("through October 29, 2026 inclusive");
  expect(policy.note).toContain("from October 30");
  expect(policy.note).toContain("https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers");
  expect(policy.note).toContain("https://x.com/thsottiaux/status/2104823812042940713");
  expect(policy.note).toContain("https://x.com/thsottiaux/status/2104951965184925941");
  expect(markerTimestamp(policy)).toBe(at);
  expect(markerUtcLabel(policy)).toBe("2026-09-29 06:41:17.000 UTC");
  expect(markerKindLabel(policy)).toBe("plan change announcement; account transition unverified");
  expect(markers.filter(isPolicyMarker)).toEqual([policy]);
  expect(capacityMarkers(null, "2026-09-29", "2026-10-31", "claude", now).some(isPolicyMarker)).toBe(false);
  setLanguage("pl");
  const polish = capacityMarkers(null, "2026-09-29", "2026-09-29", "codex", at).find(isPolicyMarker)!;
  expect(polish.label).toContain("Ogłoszenie zmiany planu · Pro 200 USD: zapowiedź zmiany limitu 20× → 10×");
  expect(polish.note).toContain("czasowo zachowają 20×");
  expect(polish.note).toContain("do 29 października 2026 włącznie");
  expect(markerKindLabel(polish)).toContain("przejście konta niepotwierdzone");
  setLanguage("en");
});

test("Limits adds completed provider resets independently of account data, excluding banked, unconfirmed and future resets", () => {
  setLanguage("en");
  const markers = capacityMarkers(null, "2026-10-01", "2026-10-20", "codex", now).filter(isProviderResetMarker);
  expect(markers.map(marker => marker.day)).toEqual(["2026-10-02", "2026-10-07", "2026-10-11", "2026-10-13", "2026-10-15", "2026-10-17", "2026-10-20"]);
  expect(markers.every(marker => isProviderResetMarker(marker) && marker.color === "crit" && marker.visible)).toBe(true);
  expect(markers.every(marker => marker.note.includes("https://x.com/thsottiaux/status/") && marker.note.includes("not proof of receipt"))).toBe(true);
  expect(capacityMarkers(null, "2026-07-09", "2026-07-09", "codex", now)).toEqual([]);
  expect(capacityMarkers(null, "2026-10-01", "2026-10-20", "claude", now)).toEqual([]);
  const beforeCompletion = capacityMarkers(null, "2026-10-20", "2026-10-20", "codex", Date.parse("2026-10-20T06:33:48Z"));
  expect(beforeCompletion).toEqual([]);
  const latest = markers.at(-1)!;
  expect(markerUtcLabel(latest)).toBe("2026-10-20 06:33:48.848 UTC");
  expect(markerKindLabel(latest)).toBe("public reset confirmation; no matching observed cycle");
  setLanguage("pl");
  expect(markerDisplayLabel(latest)).toBe("Globalny reset · brak odczytu granicy");
  expect(markerKindLabel(latest)).toBe("publiczne potwierdzenie resetu; brak dopasowanego cyklu");
  setLanguage("en");
});

test("provider resets preserve custom points and model overrides without repricing or mutating the input", () => {
  const model: TimelineMarker = { id: "model:sol", day: "2026-10-11", observed_at: "2026-10-11T12:00:00Z", label: "Sol", note: "", color: "violet", visible: true };
  const custom: TimelineMarker = { id: "custom:reset-note", day: "2026-10-11", label: "My reset note · keep this detail", note: "Personal event", color: "ok", visible: true };
  const data: TimelineMarkersResponse = { revision: "test", automatic: [model], markers: [{ ...model, visible: false }, custom] };
  const original = JSON.stringify(data);
  const markers = capacityMarkers(data, "2026-10-11", "2026-10-11", "codex", now);
  expect(markers.map(marker => marker.id)).toEqual([custom.id, "reset:codex-2026-10-11T04:01-reset"]);
  expect(markers.find(marker => marker.id === custom.id)?.color).toBe("ok");
  expect(JSON.stringify(data)).toBe(original);
});

test("promotion notices show terms and bounded ends without inventing eligibility or unknown dates", () => {
  setLanguage("en");
  const markers = capacityMarkers(null, "2026-01-01", "2026-10-20", "codex", now).filter(isPromotionMarker);
  const launch = markers.find(marker => marker.id === "promotion:codex-pro-100-launch-2026:announcement")!;
  expect(launch.day).toBe("2026-04-09");
  expect(launch.label).toContain("Pro $100: 10× Plus usage instead of 5×");
  expect(launch.note).toContain("2026-05-31");
  expect(launch.note).toContain("Pro $200 is a separate tier");
  expect(markerKindLabel(launch)).toContain("account eligibility not established");
  expect(markerUtcLabel(launch)).toContain("date only; time not published");
  const end = markers.find(marker => marker.id === "promotion:codex-pro-100-launch-2026:end")!;
  expect(end.day).toBe("2026-06-01");
  expect(end.label).toContain("Promotion ended");
  expect(markers.filter(marker => marker.id.endsWith(":end"))).toEqual([end]);
  const holiday = markers.find(marker => marker.id.includes("holiday"))!;
  expect(holiday.day).toBe("2026-01-13");
  expect(holiday.note).toContain("confirmation date, not the start");
  expect(capacityMarkers(null, "2026-05-31", "2026-06-01", "codex", Date.parse("2026-05-31T23:59:59Z")).some(marker => marker.id === end.id)).toBe(false);
  expect(capacityMarkers(null, "2026-01-01", "2026-10-20", "claude", now).filter(isPromotionMarker)).toEqual([]);
  setLanguage("pl");
  const polish = capacityMarkers(null, "2026-04-09", "2026-04-09", "codex", now).find(isPromotionMarker)!;
  expect(polish.label).toContain("Ogłoszenie promocji · Pro 100 USD: 10× użycia Plus zamiast 5×");
  setLanguage("en");
});

test("cache announcements remain timed context without a capacity multiplier or synthetic end", () => {
  setLanguage("en");
  const id = "promotion:codex-cache-retention-20261020:announcement";
  const at = Date.parse("2026-10-21T01:10:02Z");
  const read = (time: number, provider = "codex") => capacityMarkers(null, "2026-10-16", "2026-10-31", provider, time);
  expect(read(at - 1).some(m => m.id === id)).toBe(false);
  const cache = read(at).find(m => m.id === id)!;
  expect(cache.label).toContain("12h");
  expect(cache.note).toContain("October 20, Los Angeles");
  expect(cache.note).toContain("2112712984644784534");
  expect(markerTimestamp(cache)).toBe(at);
  expect(read(at).some(m => m.id === "promotion:codex-cache-retention-20261020:end")).toBe(false);
  expect(read(at, "claude").some(m => m.id === id)).toBe(false);
  setLanguage("pl");
  expect(read(at).find(m => m.id === id)!.note).toContain("To deklaracja dostawcy");
  setLanguage("en");
});
