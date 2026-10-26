import type { DirtyTimestampRange } from "./contracts";

/** Both previous and replacement timestamps must be supplied for corrections. */
export function dirtyRangesFromTimestamps(timestamps: Iterable<string>): DirtyTimestampRange[] {
  const days = new Map<string, DirtyTimestampRange>();
  for (const timestamp of timestamps) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Invalid dirty timestamp: ${timestamp}`);
    const day = timestamp.slice(0, 10);
    const range = days.get(day);
    if (!range) days.set(day, { from: timestamp, to: timestamp });
    else {
      if (timestamp < range.from) range.from = timestamp;
      if (timestamp > range.to) range.to = timestamp;
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, range]) => range);
}
