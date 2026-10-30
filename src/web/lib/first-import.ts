import { useSyncExternalStore } from "react";
import type { ProgressEntry } from "../../shared/progress";

// Shares of the whole first import, measured on 14 days of sessions (8.5 GB): copying the originals
// took about 60% of the time, the rest of the synchronization 25% and the background views 15%.
const COPY = 0.6, SYNC = 0.25, VIEWS = 0.15;
/** No estimate before this much measured work: early rates swing too much to be useful. */
const MEASURE_MS = 30_000;
const MIN_FRACTION = 0.02;
/** Background producers hand work to each other with short gaps; only this long a quiet spell ends the import. */
const SETTLE_MS = 20_000;

/** What the screen remembers between polls: copied files per source, the largest share shown, and since when all is quiet. */
export interface FirstImportMemory { copied: Map<string, number>; fraction: number; idleSince: number | null }
export const firstImportMemory = (): FirstImportMemory => ({ copied: new Map(), fraction: 0, idleSince: null });

export interface FirstImportInput {
  firstImport: { started_at: string; source_files: number | null };
  syncRunning: boolean;
  syncFinishedAt: string | null;
  /** The synchronization's own steps (`completed / total`), when it reports them. */
  steps: { completed: number; total: number } | null;
  /** Progress entries of the synchronization's sources (`sync:<vendor>`). */
  entries: readonly ProgressEntry[];
  /** Share of the background work done, or null when none is running. */
  background: number | null;
  backgroundBusy: boolean;
  now: number;
}
export interface FirstImportProgress {
  /** 0–1, never lower than a value shown before. */
  fraction: number;
  /** Null while there is not enough measured work for an estimate. */
  remainingMs: number | null;
  done: boolean;
  elapsedMs: number;
}

export function firstImportProgress(input: FirstImportInput, memory: FirstImportMemory): FirstImportProgress {
  const started = Date.parse(input.firstImport.started_at);
  const elapsedMs = Math.max(0, input.now - started);
  for (const entry of input.entries) {
    if (entry.step === "copy") memory.copied.set(entry.scope, Math.max(memory.copied.get(entry.scope) ?? 0, entry.done));
    // A source past its copy step copied everything it counted.
    else if (memory.copied.has(entry.scope) && entry.step !== "listing" && entry.step !== "select" && entry.step !== "verify")
      memory.copied.set(entry.scope, Math.max(memory.copied.get(entry.scope)!, entry.total ?? 0));
  }
  const synced = !input.syncRunning && input.syncFinishedAt !== null && Date.parse(input.syncFinishedAt) >= started;
  const copied = [...memory.copied.values()].reduce((sum, files) => sum + files, 0);
  const total = input.firstImport.source_files;
  const copy = synced ? 1 : total ? Math.min(1, copied / Math.max(total, copied)) : 0;
  const sync = synced ? 1 : input.steps && input.steps.total > 0 ? Math.min(1, input.steps.completed / input.steps.total) : 0;
  if (synced && !input.backgroundBusy) memory.idleSince ??= input.now; else memory.idleSince = null;
  const done = memory.idleSince !== null && input.now - memory.idleSince >= SETTLE_MS;
  const views = done ? 1 : synced ? input.background ?? 0 : 0;
  memory.fraction = Math.max(memory.fraction, COPY * copy + SYNC * sync + VIEWS * views);
  const fraction = done ? 1 : Math.min(0.99, memory.fraction);
  let remainingMs: number | null = null;
  if (!done && elapsedMs >= MEASURE_MS) {
    // While copying, its own rate is the best clock; afterwards the whole share of work done.
    if (copy > MIN_FRACTION && copy < 1) remainingMs = elapsedMs / copy / COPY - elapsedMs;
    else if (fraction > MIN_FRACTION) remainingMs = elapsedMs * (1 - fraction) / fraction;
    if (remainingMs !== null) remainingMs = Math.max(60_000, remainingMs);
  }
  return { fraction, remainingMs, done, elapsedMs };
}

/** Whole minutes, rounded up so an estimate never promises less than it measured. */
export const remainingMinutes = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000));

/** The first import as the status bar last saw it, for screens that explain an empty view meanwhile. */
type Shared = { active: boolean; remainingMs: number | null };
let shared: Shared = { active: false, remainingMs: null };
const listeners = new Set<() => void>();
export function publishFirstImport(next: Shared): void {
  if (next.active === shared.active && next.remainingMs === shared.remainingMs) return;
  shared = next;
  for (const listener of listeners) listener();
}
export function useFirstImport(): Shared {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => shared, () => shared);
}
