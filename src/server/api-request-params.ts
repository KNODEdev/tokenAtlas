

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split("-").map(Number);
  const [y, m, d] = parts;
  if (y === undefined || m === undefined || d === undefined) return false;
  if (y < 1970 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) return false;
  return true;
}

function daysBetween(d1: string, d2: string): number {
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  const diff = Math.abs(t2 - t1);
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

/** The `project_id` request filter: a project, null for `unassigned` (calls without one), undefined for every call. */
export function projectCond(url: URL): string | null | undefined {
  const v = url.searchParams.get("project_id");
  if (!v) return undefined;
  return v === "unassigned" ? null : v;
}

export function parseCommonDateParams(
  url: URL
): { since?: string; until?: string; error?: string } {
  const since = url.searchParams.get("since") || undefined;
  const until = url.searchParams.get("until") || undefined;
  if (since !== undefined && !isValidDateString(since)) {
    return { error: `Invalid 'since' date parameter: '${since}'. Expected format YYYY-MM-DD.` };
  }
  if (until !== undefined && !isValidDateString(until)) {
    return { error: `Invalid 'until' date parameter: '${until}'. Expected format YYYY-MM-DD.` };
  }
  if (since && until && since > until) {
    return { error: `'since' (${since}) cannot be after 'until' (${until}).` };
  }
  return { since, until };
}

export function parseInstantParams(
  url: URL
): { since_ts?: string; until_ts?: string; error?: string } {
  const since_ts = url.searchParams.get("since_ts") || undefined;
  const until_ts = url.searchParams.get("until_ts") || undefined;
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/;
  if (since_ts !== undefined && !shape.test(since_ts)) {
    return {
      error: `Invalid 'since_ts' parameter: '${since_ts}'. Expected an ISO-8601 instant, e.g. 2026-08-16T12:28:50.000Z.`,
    };
  }
  if (until_ts !== undefined && !shape.test(until_ts)) {
    return {
      error: `Invalid 'until_ts' parameter: '${until_ts}'. Expected an ISO-8601 instant, e.g. 2026-08-23T12:28:50.000Z.`,
    };
  }
  if (since_ts && until_ts && since_ts > until_ts) {
    return { error: `'since_ts' (${since_ts}) cannot be after 'until_ts' (${until_ts}).` };
  }
  return { since_ts, until_ts };
}

export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
