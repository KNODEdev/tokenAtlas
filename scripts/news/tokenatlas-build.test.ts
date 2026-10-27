import { expect, test } from "bun:test";
import type { RepoHistory } from "../../src/server/repo-history";
import { publicBuildPeriod } from "./tokenatlas-build";

function history(): RepoHistory {
  return {
    subject: { kind: "project", id: "selected-private-id" }, by: "model", since: null,
    totals: { tokens: 130, calls: 5, active_seconds: 33.25, api_usd: 2.75, api_complete: false, billed_usd: null, billed_complete: false,
      active_by_machine: { PRIVATE_MACHINE: 33.25 }, by_sub: { PRIVATE_ACCOUNT: { api_usd: 2.75, billed_usd: null } } },
    points: [
      { bucket: "2026-10-01", split: { "codex/gpt-6.1-sol": { tokens: 100, calls: 2 }, "claude/claude-opus-5-5": { tokens: 20, calls: 1 } } },
      { bucket: "2026-10-02", split: { "codex/gpt-6.1-sol": { tokens: 10, calls: 1 }, "claude/H:/PRIVATE/path": { tokens: 0, calls: 1 } } },
    ], notes: ["PRIVATE_ACCOUNT", "H:/PRIVATE/path"],
  } as unknown as RepoHistory;
}

test("the public build contains only selected project aggregates, not private dimensions", () => {
  const result = publicBuildPeriod(history(), "selected-private-id", "2026-10-26");
  expect(result).toMatchObject({ since: "2026-10-01", apiUsd: 2.75, apiComplete: false, allocatedUsd: null, allocatedComplete: false, tokens: 130, calls: 5, activeSeconds: 33.25 });
  expect(result.models).toEqual([
    { provider: "codex", model: "gpt-6.1-sol", tokens: 110, calls: 3 },
    { provider: "claude", model: "claude-opus-5-5", tokens: 20, calls: 1 },
    { provider: "claude", model: null, tokens: 0, calls: 1 },
  ]);
  for (const secret of ["PRIVATE", "selected-private-id", "by_sub", "active_by_machine", "notes"]) expect(JSON.stringify(result)).not.toContain(secret);
});

test("wrong projects and inconsistent or invalid model usage fail before publication", () => {
  expect(() => publicBuildPeriod(history(), "another-project", "2026-10-26")).toThrow("selected project");
  const wrong = history(); wrong.totals.tokens++;
  expect(() => publicBuildPeriod(wrong, "selected-private-id", "2026-10-26")).toThrow("reconcile");
  const invalid = history(); invalid.points[0]!.split!["codex/gpt-6.1-sol"]!.tokens = -1;
  expect(() => publicBuildPeriod(invalid, "selected-private-id", "2026-10-26")).toThrow("Invalid model usage");
});

test("known zero stays zero and a partial allocation stays partial", () => {
  const input = history(); input.totals.api_usd = 0; input.totals.billed_usd = 0; input.totals.api_complete = true;
  const result = publicBuildPeriod(input, "selected-private-id", "2026-10-26");
  expect(result.apiUsd).toBe(0); expect(result.apiComplete).toBe(true);
  expect(result.allocatedUsd).toBe(0); expect(result.allocatedComplete).toBe(false);
});
