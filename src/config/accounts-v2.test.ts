import { expect, test } from "bun:test";
import { parseAccountsV2, prepareAccountsV2 } from "./accounts-v2";

const row = (id: string, home: string, source_home: string, extra: Record<string, unknown> = {}) =>
  ({ id, vendor: "codex", machine: "MAIN", login: "user", home, source_home, ...extra });

test("repeated account on two machines becomes one description and two physical sources", () => {
  const result = prepareAccountsV2(JSON.stringify({ custom: { retained: true }, subscriptions: [
    row("Kuba", "${ARCHIVE}/codex/MAIN", "C:/Users/user/.codex", { note: "shared", from: "2026-01-01" }),
    { ...row("kuba", "${ARCHIVE}/codex/LAPTOP", "D:/Users/user/.codex", { note: "shared", until: "2026-09-01" }), machine: "LAPTOP" },
  ] }));
  expect(result.report).toMatchObject({ status: "ready", legacy_rows: 2, subscriptions: 1, sources: 2, removed_era_rows: 2 });
  expect(result.report.removed_fields).toEqual({ from: 1, until: 1 });
  expect(result.candidate?.custom).toEqual({ retained: true });
  expect(result.candidate?.subscriptions).toEqual([{ id: "Kuba", vendor: "codex", note: "shared" }]);
  expect(result.candidate?.sources).toHaveLength(2);
  expect(parseAccountsV2(result.candidate)).toEqual(result.candidate!);
});

test("a profile changing accounts without changing archive destination has one source", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [
    row("old", "${ARCHIVE}/codex/MAIN", "C:/Users/user/.codex", { until: "2026-09-01" }),
    row("new", "${archive}\\codex\\main\\", "c:\\users\\USER\\.CODEX", { from: "2026-09-01" }),
  ] }));
  expect(result.report.status).toBe("ready");
  expect(result.candidate?.subscriptions.map(x => x.id)).toEqual(["old", "new"]);
  expect(result.candidate?.sources).toHaveLength(1);
});

test("two destinations for one physical profile are a structured conflict", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [
    row("a", "${ARCHIVE}/codex/one", "C:/Users/user/.codex"),
    row("b", "${ARCHIVE}/codex/two", "C:/Users/user/.codex"),
  ] }));
  expect(result.candidate).toBeNull();
  expect(result.report.conflicts).toEqual([expect.objectContaining({ code: "source-destination", rows: [0, 1] })]);
});

test("one archive source named by two physical paths is never resolved by latest era", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [
    row("a", "${ARCHIVE}/codex/MAIN-sample_b", "C:/Users/sample_b/.codex", { until: "2026-09-10" }),
    row("a", "${ARCHIVE}/codex/MAIN-sample_b", "C:/Users/sample_a/.codex-2", { from: "2026-09-10" }),
  ] }));
  expect(result.candidate).toBeNull();
  expect(result.report.conflicts).toEqual([expect.objectContaining({ code: "archive-profiles", rows: [0, 1] })]);
});

test("different descriptive metadata is reported field by field without silent discard", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [
    row("codex1", "${ARCHIVE}/codex/a", "C:/a", { note: "first", history_evidence: "one" }),
    row("codex1", "${ARCHIVE}/codex/b", "C:/b", { note: "second", history_evidence: "two" }),
  ] }));
  expect(result.candidate).toBeNull();
  expect(result.report.conflicts.filter(x => x.code === "account-metadata").map(x => x.key)).toEqual([
    "codex|codex1.note", "codex|codex1.history_evidence",
  ]);
});

test("complementary account and source evidence merges without inventing a conflict", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [
    { id: "a", vendor: "codex", home: "${ARCHIVE}/codex/MAIN", note: "kept", identity_evidence: { origin: "archive" } },
    row("a", "${ARCHIVE}/codex/MAIN", "C:/Users/user/.codex", { account_key: "known-account" }),
  ] }));
  expect(result.report.status).toBe("ready");
  expect(result.candidate?.subscriptions).toEqual([{ id: "a", vendor: "codex", note: "kept",
    identity_evidence: { origin: "archive" }, account_key: "known-account" }]);
  expect(result.candidate?.sources).toEqual([{ vendor: "codex", home: "${ARCHIVE}/codex/MAIN",
    machine: "MAIN", login: "user", source_home: "C:/Users/user/.codex" }]);
});

test("v2 is idempotent and forbids era or owner fields", () => {
  const value = { version: 2 as const, _comment: "kept", subscriptions: [{ id: "a", vendor: "codex", history_evidence: { source: "archive" } }],
    sources: [{ vendor: "codex", machine: "MAIN", home: "${ARCHIVE}/codex/a", source_home: "C:/a" }] };
  const once = prepareAccountsV2(JSON.stringify(value));
  expect(once.report.status).toBe("already-v2");
  expect(once.candidate).toEqual(value);
  expect(prepareAccountsV2(JSON.stringify(once.candidate)).candidate).toEqual(value);
  expect(() => parseAccountsV2({ ...value, sources: [{ ...value.sources[0], id: "a" }] })).toThrow("physical source field");
  expect(() => parseAccountsV2({ ...value, subscriptions: [{ ...value.subscriptions[0], from: "2026-01-01" }] })).toThrow("obsolete");
});

test("legacy null source_home stays an archive-only source", () => {
  const result = prepareAccountsV2(JSON.stringify({ subscriptions: [{ id: "history", vendor: "claude", home: "${ARCHIVE}/claude/MAIN", source_home: null }] }));
  expect(result.report.status).toBe("ready");
  expect(result.candidate?.sources).toEqual([{ vendor: "claude", home: "${ARCHIVE}/claude/MAIN" }]);
});
