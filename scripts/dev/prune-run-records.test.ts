import { expect, test } from "bun:test";
import { preservesEvidence, trimRunRecord } from "./prune-run-records";

const run = (before: number, after: number, entries: number) => ({
  runId: `run-${after}`, trigger: "auto", scope: { kind: "all" }, mode: "incremental", status: "partial_success",
  startedAt: "2026-09-19T10:00:00Z", finishedAt: "2026-09-19T10:05:00Z",
  beforeRevisions: { data: before }, afterRevisions: { data: after }, aggregateWorkRequested: true,
  error: "x".repeat(50_000),
  vendors: [{
    vendor: "codex", status: "success", dataChanged: true, writtenRows: 7,
    dirtyRanges: [{ from: "2026-09-18T00:00:00Z", to: "2026-09-18T00:00:00Z" }],
    sourceImpact: { basis: "source-record-semantic-diff-v1" },
    error: null,
    diagnostics: {
      discovered: 3,
      pendingInputs: Array.from({ length: entries }, (_, index) => ({ path: `f${index}`, error: "y".repeat(10_000) })),
      warnings: Array.from({ length: entries }, (_, index) => `f${index}: ${"z".repeat(10_000)}`),
      mirror: { copied: 1, archiveFiles: Array.from({ length: entries }, (_, index) => `a${index}`), errors: [], warnings: [] },
    },
  }],
});

test("trimming a stored run record keeps every field the recovery reads", () => {
  const before = run(1, 2, 200) as unknown as Record<string, unknown>;
  const after = trimRunRecord(before);
  expect(preservesEvidence(before, after)).toBe(true);
  expect(JSON.stringify(after).length).toBeLessThan(JSON.stringify(before).length / 10);
  const diagnostics = (after.vendors as Array<Record<string, unknown>>)[0]!.diagnostics as Record<string, unknown>;
  expect((diagnostics.pendingInputs as unknown[]).length).toBe(20);
  expect(diagnostics.pendingInputsTotal).toBe(200);
  expect((diagnostics.warnings as string[])[0]!.length).toBeLessThan(2_200);
  expect(((diagnostics.mirror as Record<string, unknown>).archiveFiles as unknown[]).length).toBe(20);
  expect(String(after.error).length).toBeLessThan(2_200);
  // A record that is already small is left exactly as it was.
  const small = JSON.parse(JSON.stringify(run(2, 3, 2))) as Record<string, unknown>;
  small.error = "brief";
  const smallDiagnostics = (small.vendors as Array<Record<string, unknown>>)[0]!.diagnostics as Record<string, unknown>;
  smallDiagnostics.pendingInputs = [{ path: "f0", error: "unreadable" }];
  smallDiagnostics.warnings = ["f0: unreadable"];
  expect(trimRunRecord(small)).toEqual(small);
});
