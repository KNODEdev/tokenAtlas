import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_ROOT, CONFIG_ROOT } from "../config/paths";
import { isOwnArchiveDestination } from "./mirror";

export const DEFAULT_SYNC_RECONCILIATION_MS = 5 * 60_000;
export const DEFAULT_SYNC_DEBOUNCE_MS = 750;
// Two runs closer than this are one run: OneDrive delivers another machine's
// mirror as a stream of file events over minutes, and each run costs a
// mirror + stage + fingerprint pass per vendor.
export const DEFAULT_SYNC_MIN_GAP_MS = 5 * 60_000;

export interface SyncWatchRoot {
  path: string;
  label: string;
}

export interface SyncWatchStatus {
  active: boolean;
  running: boolean;
  followUpPending: boolean;
  reconciliationMs: number;
  debounceMs: number;
  minGapMs: number;
  nextRunNotBefore: string | null;
  watchedRoots: string[];
  missingRoots: string[];
  errors: string[];
  lastSignalAt: string | null;
  lastReconciledAt: string | null;
}

export interface SyncWatchHandle {
  close(): void;
}

export interface SyncWatchFactory {
  (
    root: string,
    onChange: (changedPath: string | null) => void,
    onError: (error: unknown) => void
  ): SyncWatchHandle;
}

export interface SyncWatchClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StartSyncWatcherOptions {
  resolveRoots?:()=>SyncWatchRoot[];
  onFileChange?: (file:string|null)=>void;
  onReconciliationNeeded?: ()=>void;
  roots?: SyncWatchRoot[];
  dbPath: string;
  runIncremental: () => Promise<void>;
  reconciliationMs?: number;
  debounceMs?: number;
  minGapMs?: number;
  watch?: SyncWatchFactory;
  clock?: SyncWatchClock;
  exists?: (root: string) => boolean;
  now?: () => string;
  report?: (message: string) => void;
  ignoreChange?: (changedPath: string | null) => boolean;
}

export interface SyncWatcher {
  signal(options?: { urgent?: boolean }): void;
  reconcile(): void;
  status(): SyncWatchStatus;
  close(): void;
}

function normalize(value: string): string {
  return path.resolve(value).replaceAll("/", path.sep).toLowerCase();
}

function containsPath(root: string, candidate: string): boolean {
  const parent = normalize(root);
  const child = normalize(candidate);
  return child === parent || child.startsWith(parent + path.sep);
}

function uniqueRoots(roots: SyncWatchRoot[]): SyncWatchRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = normalize(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Only the shared archive and the configuration are watched. Local transcript
 * folders change with every keystroke of an active session; they reach the
 * archive through the periodic mirror and the index through the periodic
 * reconciliation, not through a run per file event.
 */
export function resolvedSyncWatchRoots(): SyncWatchRoot[] {
  const roots: SyncWatchRoot[] = [{ path: ARCHIVE_ROOT, label: "shared archive" }];
  if (!containsPath(ARCHIVE_ROOT, CONFIG_ROOT)) {
    roots.push({ path: CONFIG_ROOT, label: "shared configuration" });
  }
  return uniqueRoots(roots);
}

const productionClock: SyncWatchClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

const productionWatch: SyncWatchFactory = (root, onChange, onError) => {
  const recursive = fs.statSync(root).isDirectory();
  const watcher = fs.watch(root, { recursive }, (_event, filename) => {
    const relative = filename == null ? null : filename.toString();
    onChange(relative == null ? null : recursive ? path.resolve(root, relative) : root);
  });
  watcher.on("error", onError);
  return watcher;
};

function isConfigPath(candidate: string | null): boolean {
  return candidate != null && containsPath(CONFIG_ROOT, candidate);
}

function isActiveDatabasePath(candidate: string | null, dbPath: string): boolean {
  if (!candidate) return false;
  const value = normalize(candidate);
  const database = normalize(dbPath);
  return value === database || value === `${database}-wal` || value === `${database}-shm`;
}

export function isOwnMirrorDestination(candidate: string | null): boolean {
  return isOwnArchiveDestination(candidate);
}

class NativeSyncWatcher implements SyncWatcher {
  private roots: SyncWatchRoot[];
  private readonly dbPath: string;
  private readonly runIncremental: () => Promise<void>;
  private readonly reconciliationMs: number;
  private readonly debounceMs: number;
  private readonly minGapMs: number;
  private readonly watch: SyncWatchFactory;
  private readonly clock: SyncWatchClock;
  private readonly exists: (root: string) => boolean;
  private readonly now: () => string;
  private readonly report: (message: string) => void;
  private readonly ignoreChange: (changedPath: string | null) => boolean;
  private readonly handles = new Map<string, SyncWatchHandle>();
  private readonly missing = new Set<string>();
  private readonly errors: string[] = [];
  private debounceHandle: unknown = null;
  private intervalHandle: unknown = null;
  private running = false;
  private followUpPending = false;
  private closed = false;
  private lastSignalAt: string | null = null;
  private lastReconciledAt: string | null = null;
  private lastRunFinishedMs: number | null = null;
  private urgentPending = false;

  constructor(private readonly options: StartSyncWatcherOptions) {
    this.roots = uniqueRoots(options.roots ?? resolvedSyncWatchRoots());
    this.dbPath = options.dbPath;
    this.runIncremental = options.runIncremental;
    this.reconciliationMs = options.reconciliationMs ?? DEFAULT_SYNC_RECONCILIATION_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.minGapMs = options.minGapMs ?? DEFAULT_SYNC_MIN_GAP_MS;
    this.watch = options.watch ?? productionWatch;
    this.clock = options.clock ?? productionClock;
    this.exists = options.exists ?? fs.existsSync;
    this.now = options.now ?? (() => new Date().toISOString());
    this.report = options.report ?? ((message) => console.warn(`[tokenAtlas sync-watch] ${message}`));
    this.ignoreChange = options.ignoreChange ?? isOwnMirrorDestination;
    options.onReconciliationNeeded?.();
    this.refreshWatchers();
    if (this.reconciliationMs > 0) {
      this.intervalHandle = this.clock.setInterval(() => this.reconcile(), this.reconciliationMs);
    }
  }

  signal(options: { urgent?: boolean } = {}): void {
    if (this.closed) return;
    this.lastSignalAt = this.now();
    // A configuration edit is one deliberate human action; the gap exists for
    // archive floods, so it does not apply here.
    if (options.urgent) this.urgentPending = true;
    if (this.running) {
      this.followUpPending = true;
      return;
    }
    this.armDebounce();
  }

  reconcile(): void {
    if (this.closed) return;
    this.lastReconciledAt = this.now();
    this.refreshWatchers();
    this.requestRun();
  }

  status(): SyncWatchStatus {
    return {
      active: !this.closed,
      running: this.running,
      followUpPending: this.followUpPending,
      reconciliationMs: this.reconciliationMs,
      debounceMs: this.debounceMs,
      minGapMs: this.minGapMs,
      nextRunNotBefore:
        this.lastRunFinishedMs == null ? null : new Date(this.lastRunFinishedMs + this.minGapMs).toISOString(),
      watchedRoots: [...this.handles.keys()].sort(),
      missingRoots: [...this.missing].sort(),
      errors: [...this.errors],
      lastSignalAt: this.lastSignalAt,
      lastReconciledAt: this.lastReconciledAt,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceHandle != null) this.clock.clearTimeout(this.debounceHandle);
    if (this.intervalHandle != null) this.clock.clearInterval(this.intervalHandle);
    this.debounceHandle = null;
    this.intervalHandle = null;
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }

  private armDebounce(delayMs = this.debounceMs): void {
    if (this.debounceHandle != null) this.clock.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.clock.setTimeout(() => {
      this.debounceHandle = null;
      this.requestRun();
    }, delayMs);
  }

  private requestRun(): void {
    if (this.running) {
      this.followUpPending = true;
      return;
    }
    const waitMs = this.urgentPending ? 0 : this.gapRemainingMs();
    if (waitMs > 0) {
      // Inside the minimum gap: one deferred run absorbs every signal until then.
      if (this.debounceHandle == null) this.armDebounce(waitMs);
      return;
    }
    this.urgentPending = false;
    void this.drain();
  }

  private gapRemainingMs(): number {
    if (this.lastRunFinishedMs == null || this.minGapMs <= 0) return 0;
    return Math.max(0, this.lastRunFinishedMs + this.minGapMs - Date.parse(this.now()));
  }

  private async drain(): Promise<void> {
    this.running = true;
    let passes = 0;
    try {
      do {
        this.followUpPending = false;
        passes += 1;
        try {
          await this.runIncremental();
        } catch (error) {
          this.recordError(`incremental reconciliation failed: ${String(error)}`);
        }
        this.lastRunFinishedMs = Date.parse(this.now());
        // A follow-up pass inside the same drain only when the gap allows it
        // (or the pending signal is a configuration edit); otherwise the
        // signal is deferred to the gap boundary below.
      } while (
        !this.closed &&
        this.followUpPending &&
        passes < 2 &&
        (this.urgentPending || this.gapRemainingMs() === 0) &&
        (this.urgentPending = false, true)
      );
    } finally {
      this.running = false;
      this.lastRunFinishedMs = Date.parse(this.now());
      if (!this.closed && this.followUpPending) {
        this.followUpPending = false;
        this.armDebounce(this.urgentPending ? this.debounceMs : Math.max(this.debounceMs, this.gapRemainingMs()));
      }
    }
  }

  private refreshWatchers(): void {
    if(this.options.resolveRoots) {
      const roots=uniqueRoots(this.options.resolveRoots());
      const keys=new Set(roots.map(root=>path.resolve(root.path)));
      for(const [key,handle] of this.handles)if(!keys.has(key)){handle.close();this.handles.delete(key);this.missing.delete(key);}
      this.roots=roots;
    }
    for (const root of this.roots) {
      const key = path.resolve(root.path);
      if (this.handles.has(key)) continue;
      if (!this.exists(key)) {
        if (!this.missing.has(key)) this.report(`${root.label} is unavailable: ${key}`);
        this.missing.add(key);
        continue;
      }
      try {
        const handle = this.watch(
          key,
          (changedPath) => {
            if (!isActiveDatabasePath(changedPath, this.dbPath) && !this.ignoreChange(changedPath)) {
              try { this.options.onFileChange?.(changedPath); }
              catch(error) {
                this.recordError(`Could not persist changed file: ${String(error)}`);
                try { this.options.onReconciliationNeeded?.(); }
                catch(reconcileError) { this.recordError(`Could not request source reconciliation: ${String(reconcileError)}`); }
              }
              this.signal({ urgent: root.label === "shared configuration" || isConfigPath(changedPath) });
            }
          },
          (error) => {
            this.handles.get(key)?.close();
            this.handles.delete(key);
            this.missing.add(key);
            this.options.onReconciliationNeeded?.();
            this.recordError(`${root.label} watcher failed: ${String(error)}`);
          }
        );
        this.handles.set(key, handle);
        if(this.missing.has(key))this.options.onReconciliationNeeded?.();
        this.missing.delete(key);
      } catch (error) {
        this.missing.add(key);
        this.recordError(`${root.label} watcher could not start: ${String(error)}`);
      }
    }
  }

  private recordError(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 20) this.errors.splice(0, this.errors.length - 20);
    this.report(message);
  }
}

export function startSyncWatcher(options: StartSyncWatcherOptions): SyncWatcher {
  return new NativeSyncWatcher(options);
}
