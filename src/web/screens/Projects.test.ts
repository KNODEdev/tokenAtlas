import { describe, expect, it } from "bun:test";
import type { UnassignedRow } from "../lib/api";
import { catches, groupByPath } from "./projects/assignment";

const row = (cwd: string | null, store = "codex1", project: string | null = null): UnassignedRow => ({
  vendor: "codex", store, cwd, project, calls: 1, tokens: 1, first_ts: "2026-10-01", last_ts: "2026-10-01",
});

describe("catches (assignment preview)", () => {
  it("matches the path and its subdirectories across slashes and case, not siblings", () => {
    const rule = { cwd: "C:/example/projects/SampleApp" };
    expect(catches(rule, row("C:\\example\\projects\\SampleApp"))).toBe(true);
    expect(catches(rule, row("c:\\example\\projects\\sampleapp\\src\\"))).toBe(true);
    expect(catches(rule, row("C:\\example\\projects\\SampleApp2"))).toBe(false);
    expect(catches(rule, row(null, "codex1", "SampleApp"))).toBe(false);
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
    const a = { ...row(String.raw`C:\example\projects\SampleApp`, "chatgpt-1"), tokens: 180, calls: 10, last_ts: "2026-10-17", account_ids: ["x"] };
    const b = { ...row("c:/example/projects/sampleapp/", "live"), vendor: "claude", tokens: 120, calls: 5, last_ts: "2026-10-11", account_ids: ["y", "x"] };
    const c = { ...row(String.raw`C:\example\projects\SampleApp\src`, "codex1"), tokens: 400 };
    const d = { ...row(null, "codex1", "spot"), tokens: 5 };
    const groups = groupByPath([c, a, b, d]);
    expect(groups.map((g) => g.members.length)).toEqual([1, 2, 1]);
    const [, merged] = groups;
    expect(merged!.head).toMatchObject({ tokens: 300, calls: 15, last_ts: "2026-10-17", cwd: String.raw`C:\example\projects\SampleApp`, account_ids: ["x", "y"] });
    expect(groups[0]!.head).toBe(c);
  });
});
