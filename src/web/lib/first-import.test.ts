import { expect, test } from "bun:test";
import type { ProgressEntry } from "../../shared/progress";
import { firstImportMemory, firstImportProgress, remainingMinutes, type FirstImportInput } from "./first-import";

const START = Date.parse("2026-10-30T10:00:00.000Z");
const entry = (scope: string, step: string, done: number, total: number | null): ProgressEntry =>
  ({ scope, step, label: step, done, total, unit: "files", startedAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() });
const input = (minutes: number, over: Partial<FirstImportInput> = {}): FirstImportInput => ({
  firstImport: { started_at: new Date(START).toISOString(), source_files: 1000 }, syncRunning: true, syncFinishedAt: null,
  steps: { completed: 0, total: 17 }, entries: [], background: null, backgroundBusy: false, now: START + minutes * 60_000, ...over });

test("copying sets the pace and the estimate covers the whole import", () => {
  const memory = firstImportMemory();
  const early = firstImportProgress(input(0.25, { entries: [entry("sync:codex", "copy", 10, 600)] }), memory);
  expect(early.remainingMs).toBeNull();
  // 300 of 1000 files in 3 minutes: copying takes 10 minutes, 60% of an import of about 16.7 minutes.
  const copying = firstImportProgress(input(3, { entries: [entry("sync:codex", "copy", 300, 600)] }), memory);
  expect(copying.fraction).toBeCloseTo(0.18, 5);
  expect(remainingMinutes(copying.remainingMs!)).toBe(14);
});

test("the bar never moves back when a later step reports less", () => {
  const memory = firstImportMemory();
  const before = firstImportProgress(input(4, { entries: [entry("sync:codex", "copy", 600, 600)], steps: { completed: 6, total: 17 } }), memory);
  // Codex left its copy step and Claude starts copying: the copied Codex files still count.
  const after = firstImportProgress(input(5, { entries: [entry("sync:codex", "parse", 10, 600), entry("sync:claude", "copy", 0, 400)],
    steps: { completed: 6, total: 17 } }), memory);
  expect(after.fraction).toBeGreaterThanOrEqual(before.fraction);
  const lower = firstImportProgress(input(6, { entries: [], steps: { completed: 1, total: 17 } }), memory);
  expect(lower.fraction).toBe(after.fraction);
});

test("background views finish the import and the estimate ends", () => {
  const memory = firstImportMemory();
  const views = firstImportProgress(input(8, { syncRunning: false, syncFinishedAt: new Date(START + 7 * 60_000).toISOString(),
    background: 0.5, backgroundBusy: true }), memory);
  expect(views.fraction).toBeCloseTo(0.925, 5);
  expect(views.done).toBe(false);
  expect(views.remainingMs).not.toBeNull();
  const finished = { syncRunning: false, syncFinishedAt: new Date(START + 7 * 60_000).toISOString() };
  // A short quiet gap between producers is not the end yet.
  expect(firstImportProgress(input(9, finished), memory).done).toBe(false);
  expect(firstImportProgress(input(9.2, { ...finished, backgroundBusy: true, background: 0.8 }), memory).done).toBe(false);
  expect(firstImportProgress(input(9.3, finished), memory).done).toBe(false);
  const done = firstImportProgress(input(9.7, finished), memory);
  expect(done).toMatchObject({ fraction: 1, done: true, remainingMs: null });
});

test("a synchronization from before the first import does not finish it", () => {
  const memory = firstImportMemory();
  const progress = firstImportProgress(input(1, { syncRunning: false, syncFinishedAt: new Date(START - 60_000).toISOString(), steps: null }), memory);
  expect(progress.done).toBe(false);
});
