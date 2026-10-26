import type { Database } from "bun:sqlite";

/** A reset is read again this long after it passes: the vendor needs a moment to report the new window. */
const AFTER_RESET_MS = 30_000;
/** Older resets are left to the regular probe interval. */
const RESET_HORIZON_MS = 15 * 60_000;
const RETRY_MS = 90_000;
const MAX_ATTEMPTS = 3;

export interface ProbeSubjectLimits { provider: string; subject: string; limits: Array<{ resets_at?: string | null }> }

/** The newest limits of every probed account, as the current projection keeps them. */
export function readProbeSubjectLimits(db: Database): ProbeSubjectLimits[] {
  let rows: Array<{ provider: string; subject: string; data: string }>;
  try { rows = db.query("SELECT provider,subject,data FROM current_probe_subjects").all() as typeof rows; }
  catch { return []; }
  return rows.flatMap(row => {
    try {
      const limits = (JSON.parse(row.data) as { limits?: ProbeSubjectLimits["limits"] }).limits;
      return Array.isArray(limits) ? [{ provider: row.provider, subject: row.subject, limits }] : [];
    } catch { return []; }
  });
}

/**
 * Accounts whose newest reading still names a reset that has just passed: their new window has no
 * reading yet, so the screens would wait for the regular interval (minutes) to learn its percent.
 * Each reset is read again a few times at most, so an account that stays silent costs nothing more.
 */
export class ResetProbeWatch {
  private attempts = new Map<string, { count: number; at: number }>();

  due(subjects: readonly ProbeSubjectLimits[], nowMs: number): Array<{ provider: string; subject: string }> {
    const out = new Map<string, { provider: string; subject: string }>();
    const live = new Set<string>();
    for (const { provider, subject, limits } of subjects) {
      for (const limit of limits) {
        const resetMs = limit.resets_at ? Date.parse(limit.resets_at) : NaN;
        if (!Number.isFinite(resetMs) || nowMs < resetMs + AFTER_RESET_MS || nowMs - resetMs > RESET_HORIZON_MS) continue;
        // One key per reset minute: copies of a reset differ by sub-second jitter.
        const key = JSON.stringify([provider, subject, Math.round(resetMs / 60_000)]);
        live.add(key);
        const tried = this.attempts.get(key);
        if (tried && (tried.count >= MAX_ATTEMPTS || nowMs - tried.at < RETRY_MS)) continue;
        this.attempts.set(key, { count: (tried?.count ?? 0) + 1, at: nowMs });
        out.set(JSON.stringify([provider, subject]), { provider, subject });
      }
    }
    for (const key of this.attempts.keys()) if (!live.has(key)) this.attempts.delete(key);
    return [...out.values()];
  }
}
