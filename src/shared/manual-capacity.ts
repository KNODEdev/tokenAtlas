export interface ManualCapacityMeasurement {
  id: string;
  account: string;
  counter: string;
  start: string;
  end: string;
  start_percent: number;
  end_percent: number;
  approximate_time: boolean;
  note: string;
  updated_at: string;
}

export interface ManualCapacityStore {
  revision: string;
  measurements: ManualCapacityMeasurement[];
}

export type ManualCapacityInput = Omit<ManualCapacityMeasurement, "id" | "account" | "updated_at"> & { id?: string };

export function parseCapacityCounter(value: string): [string, string, number] | null {
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 3 && typeof parts[0] === "string" && typeof parts[1] === "string"
      && parts[0].length <= 80 && parts[1].length <= 100 && typeof parts[2] === "number"
      && Number.isFinite(parts[2]) && parts[2] > 0 && parts[2] <= 366 * 1440 ? [parts[0], parts[1], parts[2]] : null;
  } catch { return null; }
}

export function manualCapacityCounters(provider: string): Array<{ id: string; label: string }> {
  const kinds = provider === "claude" ? ["weekly_all", "session"] : provider === "gemini" ? ["weekly", "five_hour"] : ["weekly", "session"];
  return kinds.flatMap(kind => (provider === "gemini" ? ["gemini", "claude"] : [kind === "weekly_all" ? "weekly" : kind]).map(group => ({
    id: JSON.stringify([kind, group, kind.startsWith("weekly") ? 10080 : 300]),
    label: `${kind} · ${group} · ${kind.startsWith("weekly") ? 10080 : 300}m`,
  })));
}
