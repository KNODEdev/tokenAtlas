import { describe, test, expect } from "bun:test";
import { emptyWindowUsage } from "./subscription-window-comparison";
import { fixtureTraffic, meterWindowsFixture } from "./window-usage.fixture";
import { attachWindowEvidence } from "./subscription-evidence";
import { buildEraIndex } from "./eras";
import { assessWindowQuality, filterWindowQuality } from "../shared/subscription-quality";
import type { CodexProbe } from "./codex-calibration";
import { Database } from "../db/sqlite";
import { loadSubscriptionImportEvidence, importEvidenceForWindow } from "./subscription-import-evidence";

const probe = (ts: string, used_percent: number): CodexProbe => ({ subject: "a", ts, used_percent, resets_at: "2026-09-12T05:00:00Z", window_minutes: 300, kind: "probe", plan: "pro" });
const event = (ts: string, extra = {}) => ({ ts, account: "a", model: "m", home: "pc1", ...extra });
function fixture() {
  const rows = meterWindowsFixture([
    event("2026-09-12T00:05:00Z"), event("2026-09-12T00:15:00Z"), event("2026-09-12T01:00:00Z", { home: "pc2" }),
    event("2026-09-12T00:10:00Z", { model: "separate" }),
    event("2026-09-12T00:10:00Z", { plan_type: "plus" }),
    event("2026-09-12T00:10:00Z", { meter_reset: Date.parse("2026-09-13T05:00:00Z") / 1000 }),
  ], [probe("2026-09-12T00:00:00Z", 0), probe("2026-09-12T00:20:00Z", 20)], fixtureTraffic({
    windowMinutes: 300, include: e => e.model !== "separate",
    usage: () => ({ ...emptyWindowUsage(), events: 1, tokens: 100, input: 90, output: 10, priced_tokens: 100, api_standard: 1 }),
  }));
  rows[0]!.plan_detail = { label: "Pro", multiplier: 20, status: "resolved" };
  return rows[0]!;
}

describe("cycle evidence without false completeness", () => {
  test("separates cycle/paired sources and explains excluded candidates", () => {
    const w = fixture();
    // The "plus"-stamped event belongs to the window by its time: a plan is never read from an event.
    expect(w.usage.tokens).toBe(300); expect(w.cycle_usage!.tokens).toBe(400);
    expect(w.evidence!.excluded_events).toEqual({ counter: 1, plan: 0, reset: 1 });
    expect(w.evidence!.sources.find(s => s.name === "pc2")).toMatchObject({ events: 1, tokens: 100, paired_events: 0 });
    expect(w.evidence!.meter_gaps).toEqual([{ from: "2026-09-12T00:00:00.000Z", to: "2026-09-12T00:20:00.000Z", minutes: 20 }]);
    expect(w.evidence!.archive_completeness).toBe("unconfirmed");
  });
  test("expected sources follow historical declarations and aliases", () => {
    const w = fixture();
    attachWindowEvidence([w], { provider: "codex", eras: buildEraIndex([
      { id: "a", vendor: "codex", home: "PC1", source_home: "archive/pc1" },
      { id: "a", vendor: "codex", home: "offline" },
      { id: "a", vendor: "codex", home: "retired", until: "2026-09-01" },
      { id: "a", vendor: "claude", home: "other-vendor" },
    ]) });
    expect(w.evidence!.declared_sources).toEqual([{ name: "archive/pc1", observed: true }, { name: "offline", observed: false }]);
    expect(assessWindowQuality(w).reasons).toContain("source_without_traffic");
  });
  test("eligibility does not certify completeness and weak data stays visible", () => {
    const w = fixture(); w.evidence!.excluded_events = { counter: 0, plan: 0, reset: 0 };
    expect(assessWindowQuality(w)).toEqual({ status: "comparable", reasons: [], rounding: { lower_pp: 18, upper_pp: 22 } });
    w.start_basis = "reset"; w.first_probe = { ts: w.end, percent: 20 };
    expect(assessWindowQuality(w).reasons).toContain("inferred_zero");
    expect(filterWindowQuality([w], "comparable")).toHaveLength(0);
    expect(filterWindowQuality([w], "partial")).toHaveLength(1);
    expect(filterWindowQuality([w], "all")).toHaveLength(1);
  });
  test("mode relevance belongs to adapter, missing prices still disqualify", () => {
    const w = fixture(); w.evidence!.excluded_events = { counter: 0, plan: 0, reset: 0 }; w.usage.unknown_tokens = 200;
    expect(assessWindowQuality(w).reasons).toContain("unknown_mode");
    attachWindowEvidence([w], { provider: "claude", modeRelevant: false });
    expect(assessWindowQuality(w).status).toBe("comparable");
    w.usage.unpriced_events = w.usage.events;
    expect(assessWindowQuality(w).status).toBe("insufficient");
  });
  test("rounding scenario exposes unstable small denominators", () => {
    const w = fixture(); w.observed_pp = 2;
    expect(assessWindowQuality(w).rounding.lower_pp).toBe(0);
    expect(assessWindowQuality(w).status).toBe("insufficient");
  });
  test("account-named stores resolve one declared source but never invent which of two PCs supplied traffic", () => {
    const w = fixture(); w.evidence!.sources[0]!.name = "a"; w.evidence!.sources.splice(1);
    attachWindowEvidence([w], { provider: "gemini", eras: buildEraIndex([{ id: "a", vendor: "gemini", home: "physical1" }]) });
    expect(w.evidence!.declared_sources[0]!.observed).toBe(true);
    attachWindowEvidence([w], { provider: "gemini", eras: buildEraIndex([{ id: "a", vendor: "gemini", home: "physical1" }, { id: "a", vendor: "gemini", home: "physical2" }]) });
    expect(w.evidence!.declared_sources.map(s => s.observed)).toEqual([null, null]);
    expect(assessWindowQuality(w).reasons).toContain("source_identity_unresolved");
    expect(assessWindowQuality(w).reasons).not.toContain("source_without_traffic");
  });
  test("imprecise own-counter events are distinguished from legitimate separate-counter exclusions", () => {
    const w = meterWindowsFixture([event("2026-09-12T00:05:00Z"), event("2026-09-12T00:10:00Z", { model: "imprecise" })], [probe("2026-09-12T00:00:00Z", 0), probe("2026-09-12T00:20:00Z", 20)], fixtureTraffic({
      windowMinutes: 300, include: e => e.model !== "imprecise", exclusionReason: () => "imprecise_time",
      usage: () => ({ ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100 }),
    }))[0]!;
    w.plan_detail = { status: "resolved", multiplier: 20, label: "Pro" };
    expect(w.evidence!.excluded_events.imprecise_time).toBe(1);
    expect(assessWindowQuality(w).status).toBe("partial");
    expect(assessWindowQuality(w).reasons).toContain("imprecise_time");
  });
  test("aggregate store traffic leaves the physical source unresolved unless explicitly mapped", () => {
    const w = fixture(); w.evidence!.sources[0]!.name = "live"; w.evidence!.sources.splice(1);
    const context = { provider: "claude", opaqueSources: ["live", "desktop"] };
    attachWindowEvidence([w], { ...context, eras: buildEraIndex([{ id: "a", vendor: "claude", home: "physical1" }]) });
    expect(w.evidence!.declared_sources).toEqual([{ name: "physical1", observed: null }]);
    expect(assessWindowQuality(w).reasons).toContain("source_identity_unresolved");
    expect(assessWindowQuality(w).reasons).not.toContain("source_without_traffic");
    attachWindowEvidence([w], { ...context, eras: buildEraIndex([{ id: "a", vendor: "claude", home: "live", source_home: "physical1" }]) });
    expect(w.evidence!.declared_sources).toEqual([{ name: "physical1", observed: true }]);
  });
  test("persisted sync results are provider evidence, not inferred source uptime", () => {
    const db = new Database(":memory:");
    try {
      expect(loadSubscriptionImportEvidence(db, "codex")).toBeNull();
      db.run("CREATE TABLE sync_runs(run_id TEXT, started_at TEXT, result_json TEXT)");
      db.run("INSERT INTO sync_runs VALUES (?,?,?)", ["r", "2026-09-13T01:00:00Z", JSON.stringify({ vendors: [{ vendor: "codex", status: "success", dirtyRange: { from: "2026-09-12T01:00:00Z", to: "2026-09-12T02:00:00Z" }, diagnostics: { mirror: { warnings: ["source unavailable"] } } }] })]);
      db.run("INSERT INTO sync_runs VALUES ('bad','2026-09-13T02:00:00Z','broken')");
      const e = importEvidenceForWindow(loadSubscriptionImportEvidence(db, "codex")!, "2026-09-12T00:00:00Z", "2026-09-12T05:00:00Z");
      expect(e).toMatchObject({ stored_runs: 2, inspected_runs: 2, unreadable_runs: 1, related_count: 1 });
      expect(e.related[0]).toMatchObject({ relation: "changed_range", warnings: 1, has_error: false });
      expect(loadSubscriptionImportEvidence(db, "claude")!.entries).toHaveLength(0);
    } finally { db.close(); }
  });
  test("a running result is read again once the run has ended, and an ended one is reduced once", () => {
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE sync_runs(run_id TEXT, started_at TEXT, status TEXT, result_json TEXT)");
      const result = (status: string, error: string | null) => JSON.stringify({ vendors: [{ vendor: "codex", status, error,
        diagnostics: { mirror: { warnings: [], padding: "x".repeat(200000) } } }] });
      db.run("INSERT INTO sync_runs VALUES ('live','2026-09-13T01:00:00Z','running',?)", [result("running", null)]);
      expect(loadSubscriptionImportEvidence(db, "codex")!.entries[0]).toMatchObject({ status: "running", has_error: false });
      db.run("UPDATE sync_runs SET status='failure',result_json=? WHERE run_id='live'", [result("failure", "mirror failed")]);
      expect(loadSubscriptionImportEvidence(db, "codex")!.entries[0]).toMatchObject({ status: "failure", has_error: true });
      // An ended run never changes, so its stored result is not opened a second time.
      db.run("UPDATE sync_runs SET result_json='broken' WHERE run_id='live'");
      expect(loadSubscriptionImportEvidence(db, "codex")).toMatchObject({ unreadable: 0, entries: [{ status: "failure" }] });
    } finally { db.close(); }
  });
});

describe("cycle plans", () => {
  const weekly = (ts: string, used: number, plan: string | null): CodexProbe => ({ subject: "a", ts, used_percent: used,
    resets_at: "2026-09-19T00:00:00Z", window_minutes: 10080, kind: "weekly_all", plan });
  const cut = (plans: Array<string | null>) => meterWindowsFixture([], plans.map((plan, i) => weekly(`2026-09-1${3 + i}T00:00:00Z`, 10 * (i + 1), plan)), fixtureTraffic({
    windowMinutes: 10080, include: () => true, usage: () => emptyWindowUsage() })).map(w => w.plan);
  test("an unknown plan is not a plan change, and the first known plan names the cycle", () => {
    expect(cut([null, "max-5x", "max-5x"])).toEqual(["max-5x"]);
    expect(cut(["max-5x", null, "max-5x"])).toEqual(["max-5x"]);
  });
  test("two known, different plans mark one uninterrupted meter segment mixed", () => {
    expect(cut(["pro", "pro", "max-5x", "max-5x"])).toEqual([null]);
  });
});
