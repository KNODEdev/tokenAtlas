import { describe, expect, test } from "bun:test";
import type { UnassignedRow } from "../../lib/api";
import { bulkRules, filterRows, groupByPath } from "./assignment";

const row = (cwd: string | null, extra: Partial<UnassignedRow> = {}): UnassignedRow => ({
  vendor: "codex", store: "codex1", cwd, project: cwd ? cwd.split(/[\\/]/).pop()! : "loose",
  calls: 1, tokens: 10, first_ts: "2026-11-01T00:00:00Z", last_ts: "2026-11-02T00:00:00Z", ...extra,
});

describe("unassigned search", () => {
  const rows = [
    row("H:\\_Dev\\repos\\clients\\TactShift"),
    row("D:/AI/sellFlow", { vendor: "claude", account_ids: ["claude-max"] }),
    row(null),
  ];
  test("every word must match, case-insensitive, across slashes", () => {
    expect(filterRows(rows, "tactshift").map(r => r.project)).toEqual(["TactShift"]);
    expect(filterRows(rows, "repos/clients TACT").length).toBe(1);
    expect(filterRows(rows, "repos sellflow")).toEqual([]);
  });
  test("vendor and account ids are searched; an empty query keeps every row", () => {
    expect(filterRows(rows, "claude-max").map(r => r.project)).toEqual(["sellFlow"]);
    expect(filterRows(rows, "  ")).toBe(rows);
  });
});

describe("bulk rules", () => {
  const groups = groupByPath([row("C:/w/app"), row("C:/w/app/sub"), row("C:/w/apple"), row(null)]);
  test("new rules leave out a directory a selected parent already catches", () => {
    expect(bulkRules(groups, true)).toEqual([{ cwd: "C:/w/app" }, { cwd: "C:/w/apple" }, { project: "loose" }]);
  });
  test("moving existing rules keeps every directory", () => {
    expect(bulkRules(groups, false)).toHaveLength(4);
  });
});
