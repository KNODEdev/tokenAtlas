import { describe, expect, it } from "bun:test";
import type { UnassignedRow } from "../lib/api";
import { catches, groupByPath } from "./projects/assignment";

const row = (cwd: string | null, store = "codex1", project: string | null = null): UnassignedRow => ({
  vendor: "codex", store, cwd, project, calls: 1, tokens: 1, first_ts: "2026-10-01", last_ts: "2026-10-01",
});

describe("catches (assignment preview)", () => {
  it("matches the path and its subdirectories across slashes and case, not siblings", () => {
    const rule = { cwd: "H:/_Dev/repos/products/fireMonitor" };
    expect(catches(rule, row("H:\\_Dev\\repos\\products\\fireMonitor"))).toBe(true);
    expect(catches(rule, row("h:\\_dev\\repos\\products\\firemonitor\\src\\"))).toBe(true);
    expect(catches(rule, row("H:\\_Dev\\repos\\products\\fireMonitor2"))).toBe(false);
    expect(catches(rule, row(null, "codex1", "fireMonitor"))).toBe(false);
  });

  it("honours a store-scoped rule and basename rules", () => {
    expect(catches({ cwd: "H:/a", store: "live" }, row("H:\\a", "Live"))).toBe(true);
    expect(catches({ cwd: "H:/a", store: "live" }, row("H:\\a", "codex1"))).toBe(false);
    expect(catches({ project: "Spot" }, row(null, "codex1", "spot"))).toBe(true);
    expect(catches({}, row("H:\\a"))).toBe(false);
  });
});

describe("groupByPath", () => {
  it("joins one directory across vendors and accounts into a summed line, larger groups first", () => {
    const a = { ...row(String.raw`H:\p\fireMonitor`, "chatgpt-1"), tokens: 180, calls: 10, last_ts: "2026-10-17", account_ids: ["x"] };
    const b = { ...row("h:/p/firemonitor/", "live"), vendor: "claude", tokens: 120, calls: 5, last_ts: "2026-10-11", account_ids: ["y", "x"] };
    const c = { ...row(String.raw`H:\p\fireMonitor\src`, "codex1"), tokens: 400 };
    const d = { ...row(null, "codex1", "spot"), tokens: 5 };
    const groups = groupByPath([c, a, b, d]);
    expect(groups.map((g) => g.members.length)).toEqual([1, 2, 1]);
    const [, fire] = groups;
    expect(fire!.head).toMatchObject({ tokens: 300, calls: 15, last_ts: "2026-10-17", cwd: String.raw`H:\p\fireMonitor`, account_ids: ["x", "y"] });
    expect(groups[0]!.head).toBe(c);
  });
});
