import { expect, test } from "bun:test";
import type { RepoHistory } from "../../src/server/repo-history";
import type { ProjectCostResponse } from "../../src/server/project-cost";
import { publicBuildPeriod, publicDrawerSummary } from "./tokenatlas-build";

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

function cost(): ProjectCostResponse {
  const slice = (api_usd: number, billed_usd: number | null, tokens: number, billed_complete = true) => ({ api_usd, billed_usd, billed_complete, tokens });
  return {
    since: null, until: null,
    subscriptions: [{ id: "PRIVATE_CODEX", vendor: "codex" }, { id: "claude-PRIVATE", vendor: "claude" }, { id: "codex-PRIVATE-2", vendor: "codex" }],
    subjects: [{ subject: "p:selected-private-id", kind: "project", id: "selected-private-id", tokens: 300, calls: 9, api_usd: 16, billed_usd: 2.5, billed_complete: false,
      by_sub: { PRIVATE_CODEX: 10 }, subscriptions: { PRIVATE_CODEX: slice(10, 2, 100), "claude-PRIVATE": slice(4, 0.5, 120, false), "codex-PRIVATE-2": slice(1.5, null, 50), "codex?": slice(0.5, null, 30) } }],
  } as unknown as ProjectCostResponse;
}

test("the drawer summary compares subscription cost with API value under per-vendor letters", () => {
  const all = publicBuildPeriod(history(), "selected-private-id", "2026-10-26");
  const result = publicDrawerSummary(cost(), "selected-private-id", all);
  expect(result).toMatchObject({ since: "2026-10-01", until: "2026-10-26", paidUsd: 2.5, paidComplete: false, apiUsd: 16, tokens: 300, calls: 9, activeSeconds: 33.25 });
  expect(result.subscriptions).toEqual([
    { vendor: "codex", label: "A", paidUsd: 2, paidComplete: true, apiUsd: 10, tokens: 100 },
    { vendor: "claude", label: "A", paidUsd: 0.5, paidComplete: false, apiUsd: 4, tokens: 120 },
    { vendor: "codex", label: "B", paidUsd: null, paidComplete: false, apiUsd: 1.5, tokens: 50 },
    { vendor: "codex", label: null, paidUsd: null, paidComplete: false, apiUsd: 0.5, tokens: 30 },
  ]);
  for (const secret of ["PRIVATE", "selected-private-id", "codex?"]) expect(JSON.stringify(result)).not.toContain(secret);
  const ranged = cost(); (ranged as { since: string | null }).since = "2026-10-01";
  expect(() => publicDrawerSummary(ranged, "selected-private-id", all)).toThrow("all-time");
  const wrong = cost(); wrong.subjects[0]!.api_usd = 99;
  expect(() => publicDrawerSummary(wrong, "selected-private-id", all)).toThrow("reconcile");
});
