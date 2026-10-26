import { expect, test } from "bun:test";
import { canonicalJson } from "../../config/canonical-json";
import { createProbeCollection, validateCanonicalProbe, type CanonicalProbe } from "../../db/probe-facts";
import { compactProbeBase, compactProbeLine, expandCompactProbe } from "./journal-compact";

const ENTRY = "11111111-1111-4111-8111-111111111111";
function reading(ts: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: "claude", subject: "claude-main", ts, plan: "max", kind: "weekly_all", limit_group: null, scope: null,
    reported_percent_side: "used", used_percent: 41, remaining_percent: 59, vendor_percent: 41, window_minutes: 10080,
    allowance: null, used: null, remaining: null, resets_at: "2026-09-25T10:00:00.000Z", rate_limit_reached: 0,
    reset_credits: null, profile: "default", ok: 1, error: null,
    extra: JSON.stringify({ home: "C:/Users/x/.claude", as_of: ts, breakdown: { claude_code: 30, chat: 8, cowork: 2, other: 1 } }),
    machine: "PC", login: "user", source_home: "C:/Users/x/.claude", raw_subject: "claude-main", ...overrides };
}
const fact = (row: Record<string, unknown>): CanonicalProbe => createProbeCollection([row])[0]!;
const expand = (line: string, base: CanonicalProbe | null) => expandCompactProbe(JSON.parse(line) as Record<string, unknown>, base);

test("a self-contained line expands to the accepted canonical probe and the flat record of version 2", () => {
  const original = fact(reading("2026-09-21T10:00:00.000Z", { raw_subject: "Claude Main" }));
  const { line, full } = compactProbeLine(ENTRY, original, null);
  expect(full).toBe(true);
  expect(line).not.toContain("counter_id");
  const { fact: expanded, outer } = expand(line, null);
  expect(canonicalJson(expanded)).toBe(canonicalJson(original));
  expect(() => validateCanonicalProbe(expanded, outer)).not.toThrow();
  expect(outer.journal_entry_id).toBe(ENTRY);
  // Less than half of the version 2 line for the same reading.
  expect(line.length * 2).toBeLessThan(JSON.stringify({ ...original.payload, canonical_probe: original, journal_version: 2, journal_entry_id: ENTRY }).length);
});

test("an unchanged reading is a short reference; a moved read time inside extra travels as a patch", () => {
  const base = fact(reading("2026-09-21T10:00:00.000Z"));
  const next = fact(reading("2026-09-21T10:10:00.000Z"));
  const { line, full } = compactProbeLine(ENTRY, next, base);
  expect(full).toBe(false);
  expect(line.length).toBeLessThan(400);
  expect(compactProbeBase(JSON.parse(line) as Record<string, unknown>)).toBe(base.counter_id);
  expect(canonicalJson(expand(line, base).fact)).toBe(canonicalJson(next));
  // The four surface counters survive a change, exactly.
  const moved = fact(reading("2026-09-21T10:20:00.000Z", { used_percent: 42, remaining_percent: 58, vendor_percent: 42,
    extra: JSON.stringify({ home: "C:/Users/x/.claude", as_of: "2026-09-21T10:20:00.000Z", breakdown: { claude_code: 31, chat: 8, cowork: 2, other: 1 } }) }));
  const changed = compactProbeLine(ENTRY, moved, base);
  expect(changed.full).toBe(false);
  expect(expand(changed.line, base).fact.payload).toEqual(moved.payload);
});

test("a repeated error row and a value that turns null both round-trip", () => {
  const failing = { used_percent: null, remaining_percent: null, vendor_percent: null, ok: 0, error: "HTTP 401", extra: null };
  const base = fact(reading("2026-09-21T10:00:00.000Z", failing));
  const again = fact(reading("2026-09-21T10:10:00.000Z", failing));
  const repeat = compactProbeLine(ENTRY, again, base);
  expect(repeat.full).toBe(false);
  expect(canonicalJson(expand(repeat.line, base).fact)).toBe(canonicalJson(again));
  const recovered = fact(reading("2026-09-21T10:20:00.000Z"));
  expect(canonicalJson(expand(compactProbeLine(ENTRY, recovered, base).line, base).fact)).toBe(canonicalJson(recovered));
  const cleared = fact(reading("2026-09-21T10:30:00.000Z", { resets_at: null }));
  const healthy = fact(reading("2026-09-21T10:00:00.000Z"));
  expect(expand(compactProbeLine(ENTRY, cleared, healthy).line, healthy).fact.payload.resets_at).toBeNull();
});

test("extra text a patch cannot reproduce exactly is carried whole", () => {
  const base = fact(reading("2026-09-21T10:00:00.000Z", { extra: '{"a": 1,"b":2}' }));
  const next = fact(reading("2026-09-21T10:10:00.000Z", { extra: '{"a": 1,"b":3}' }));
  const { line } = compactProbeLine(ENTRY, next, base);
  expect(expand(line, base).fact.payload.extra).toBe('{"a": 1,"b":3}');
});

test("a reference without its base, a wrong base or a tampered line is refused", () => {
  const base = fact(reading("2026-09-21T10:00:00.000Z"));
  const next = fact(reading("2026-09-21T10:10:00.000Z"));
  const { line } = compactProbeLine(ENTRY, next, base);
  expect(() => expand(line, null)).toThrow("Invalid compact probe reference");
  const other = fact(reading("2026-09-21T10:00:00.000Z", { used_percent: 7 }));
  expect(() => expand(line, other)).toThrow("Compact probe digest mismatch");
  const tampered = JSON.stringify({ ...JSON.parse(line) as Record<string, unknown>, t: "2026-09-21T10:11:00.000Z" });
  expect(() => expand(tampered, base)).toThrow("Compact probe digest mismatch");
});
