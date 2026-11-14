/** What the menu's status foot says: freshness, the time it rests on, and the indexed calls when known. */
export interface NavStatusFacts {
  lastSync: string | null;
  calls: number | null;
  /** null while the application's state is not known yet. */
  live: boolean | null;
  /** "series": the selected subscription's samples; "sync": the application's last synchronization. */
  basis: "series" | "sync";
}

const FRESH_MS = 6 * 3_600_000;

/**
 * A subscription with a sample series speaks for itself. Without one (Claude, all subscriptions, screens that read
 * no subscription) the foot reports the application's synchronization instead of "no fresh data".
 */
export function navStatus(
  series: { lastSync: string | null; calls: number | null; live: boolean },
  hasSeries: boolean,
  sync: { running: boolean; finished_at: string | null; ok: boolean | null } | null,
  now = Date.now(),
): NavStatusFacts {
  if (hasSeries) return { ...series, basis: "series" };
  if (!sync) return { lastSync: null, calls: null, live: null, basis: "sync" };
  const finished = sync.finished_at ? Date.parse(sync.finished_at) : NaN;
  const recent = Number.isFinite(finished) && now - finished < FRESH_MS && sync.ok !== false;
  return { lastSync: sync.finished_at, calls: null, live: sync.running || recent, basis: "sync" };
}
