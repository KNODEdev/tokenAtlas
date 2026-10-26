import { describe, expect, test } from "bun:test";
import { buildAccountResolver } from "./account-resolver";
import type { DatedPeriod } from "./account-periods";
import { archiveSourceKey, codexHomeSource, subscriptionRowSource } from "./event-source";

const period = (subject: string, from: string, until: string | null, value: string, origin: DatedPeriod["origin"] = "observed", provider = "claude"): DatedPeriod =>
  ({ provider, subject, from, until, value, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });

describe("account resolver", () => {
  const periods = [
    period("claude/EXAMPLE-MAIN", "2026-01-01", "2026-03-29", "claude-A", "declared"),
    period("claude/EXAMPLE-MAIN", "2026-09-09T15:48:00.000Z", null, "claude-B"),
    period("claude/EXAMPLE-MAIN", "2026-09-10", "2026-09-11", "claude-A", "declared"),
    period("codex/example-main-sample_a", "2026-09-09T15:11:00.000Z", null, "codex1", "observed", "codex"),
  ];
  const resolver = buildAccountResolver(periods, [{ id: "claude-A", account_key: "claude:a:a", vendor: "claude" }]);

  test("precedence: identity, declared, observed, then explicit gap or uncovered", () => {
    expect(resolver.resolve("claude", "claude/example-main", "claude:a:a", "2026-09-15T00:00:00Z")).toEqual({ account: "claude-a", basis: "identity" });
    expect(resolver.resolve("claude", "claude/example-main", null, "2026-02-01T00:00:00Z")).toEqual({ account: "claude-a", basis: "declared" });
    expect(resolver.resolve("claude", "claude/example-main", null, "2026-09-10T12:00:00Z")).toEqual({ account: "claude-a", basis: "declared" });
    expect(resolver.resolve("claude", "claude/example-main", null, "2026-09-15T00:00:00Z")).toEqual({ account: "claude-b", basis: "observed" });
    expect(resolver.resolve("claude", "claude/example-main", null, "2026-06-01T00:00:00Z")).toEqual({ account: null, basis: "gap" });
    expect(resolver.resolve("claude", "claude/example-main", null, "2025-06-01T00:00:00Z")).toEqual({ account: null, basis: "uncovered" });
    expect(resolver.resolve("claude", null, null, "2026-09-15T00:00:00Z")).toEqual({ account: null, basis: "no-source" });
  });

  test("an undeclared identity still maps to a stable derived id", () => {
    const derived = resolver.identityAccount("claude", "claude:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222");
    expect(derived).toMatch(/^claude-[0-9a-f]{16}$/);
    expect(resolver.identityAccount("codex", "anything")).toBeNull();
  });

  test("identity dependency keys cover declared aliases and identities before their first event", () => {
    const raw = "claude:a:a";
    const derived = buildAccountResolver([]).identityAccount("claude", raw)!;
    expect(resolver.plan("claude", "claude-A").identityKeys).toContain(derived);
    expect(buildAccountResolver([]).plan("claude", derived).identityKeys).toEqual([derived]);
    expect(resolver.plan("codex", "codex1").identityKeys).toEqual([]);
  });

  test("a plan carves declared time out of an observed period of another account", () => {
    const plan = resolver.plan("claude", "CLAUDE-B");
    expect(plan.ranges).toEqual([
      { source: "claude/example-main", from: Date.parse("2026-09-09T15:48:00.000Z"), until: Date.parse("2026-09-10T00:00:00Z") },
      { source: "claude/example-main", from: Date.parse("2026-09-11T00:00:00Z"), until: Infinity },
    ]);
    expect(plan.owns("claude/example-main", null, "2026-09-10T12:00:00Z")).toBe(false);
    expect(plan.owns("claude/example-main", null, "2026-09-12T12:00:00Z")).toBe(true);
    expect(plan.owns("claude/example-main", "claude:a:a", "2026-09-12T12:00:00Z")).toBe(false);
    expect(plan.owns("claude/other", null, "2026-09-12T12:00:00Z")).toBe(false);
    expect(plan.owns(null, null, "2026-09-12T12:00:00Z")).toBe(false);
  });

  test("days: whole days inside a period, cut days at its edges", () => {
    const plan = resolver.plan("claude", "claude-b");
    const days = plan.days("2026-09-08", "2026-09-12");
    expect(days).toEqual([
      { source: "claude/example-main", day: "2026-09-09", whole: false, from: Date.parse("2026-09-09T15:48:00.000Z"), until: Date.parse("2026-09-10T00:00:00Z") },
      { source: "claude/example-main", day: "2026-09-11", whole: true, from: Date.parse("2026-09-11T00:00:00Z"), until: Date.parse("2026-09-12T00:00:00Z") },
      { source: "claude/example-main", day: "2026-09-12", whole: true, from: Date.parse("2026-09-12T00:00:00Z"), until: Date.parse("2026-09-13T00:00:00Z") },
    ]);
    expect(resolver.plan("codex", "codex1").days("2026-09-09", "2026-09-09")).toEqual([
      { source: "codex/example-main-sample_a", day: "2026-09-09", whole: false, from: Date.parse("2026-09-09T15:11:00.000Z"), until: Date.parse("2026-09-10T00:00:00Z") },
    ]);
    expect(resolver.accounts("claude")).toEqual(["claude-a", "claude-b"]);
  });
});

describe("event source", () => {
  const root = "H:\\Archive\\tokenUsage";
  test("archive paths map to <provider>/<folder>; anything else has no source", () => {
    expect(archiveSourceKey("H:\\Archive\\tokenUsage\\claude\\EXAMPLE-MAIN\\projects\\x\\y.jsonl", root)).toBe("claude/example-main");
    expect(archiveSourceKey("h:/archive/tokenusage/codex/EXAMPLE-MAIN-sample_a", root)).toBe("codex/example-main-sample_a");
    expect(archiveSourceKey("C:\\Users\\sample_a\\.codex", root)).toBeNull();
    expect(archiveSourceKey("H:\\Archive\\tokenUsage\\codex", root)).toBeNull();
  });
  test("a local Codex home follows its declaration; an undeclared or ambiguous one stays unassigned", () => {
    const declarations = [
      { vendor: "codex", home: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_a", source_home: "C:\\Users\\sample_a\\.codex" },
      { vendor: "codex", home: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-sample_b", source_home: "C:\\Users\\sample_a\\.codex-2" },
      { vendor: "codex", home: "H:\\Archive\\tokenUsage\\codex\\EXAMPLE-MAIN-other", source_home: "C:\\Users\\sample_a\\.codex-2" },
    ];
    expect(codexHomeSource("C:\\Users\\sample_a\\.codex", declarations, root)).toBe("codex/example-main-sample_a");
    expect(codexHomeSource("c:/users/sample_a/.codex/", declarations, root)).toBe("codex/example-main-sample_a");
    expect(codexHomeSource("H:\\Archive\\tokenUsage\\codex\\EXAMPLE-LAPTOP-A-sample_a", declarations, root)).toBe("codex/example-laptop-a-sample_a");
    expect(codexHomeSource("C:\\Users\\sample_a\\.codex-2", declarations, root)).toBeNull();
    expect(codexHomeSource("C:\\Users\\sample_a\\.codex-9", declarations, root)).toBeNull();
    expect(codexHomeSource(null, declarations, root)).toBeNull();
  });
  test("subscription rows: path for Claude, Gemini and Grok; store for GLM", () => {
    expect(subscriptionRowSource("claude", { path: "H:\\Archive\\tokenUsage\\claude\\EXAMPLE-LAPTOP-A\\a.jsonl", store: "live" }, root)).toBe("claude/example-laptop-a");
    expect(subscriptionRowSource("gemini", { path: "H:\\Archive\\tokenUsage\\gemini\\EXAMPLE-MAIN-agy11\\c\\x.json", store: "unassigned:gemini:x" }, root)).toBe("gemini/example-main-agy11");
    expect(subscriptionRowSource("glm", { store: "EXAMPLE-MAIN" }, root)).toBe("glm/example-main");
    expect(subscriptionRowSource("glm", { store: "" }, root)).toBeNull();
    expect(subscriptionRowSource("claude", { path: null }, root)).toBeNull();
  });
});
