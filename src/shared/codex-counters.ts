/** Independent account meters; a slot name never determines its duration. */
export const CODEX_COUNTERS = {
  10080: { id: "weekly", label: "Weekly" },
  300: { id: "five_hour", label: "5h" },
  43200: { id: "thirty_day", label: "30d" },
} as const;
export const CODEX_WINDOW_MINUTES = [10080, 300, 43200] as const;
export type CodexWindowMinutes = typeof CODEX_WINDOW_MINUTES[number];
export const isCodexWindowMinutes = (value: number): value is CodexWindowMinutes =>
  CODEX_WINDOW_MINUTES.some(minutes => minutes === value);

export function codexCounterMinutes(counter: string): CodexWindowMinutes | null {
  return CODEX_WINDOW_MINUTES.find(minutes => CODEX_COUNTERS[minutes].id === counter) ?? null;
}

/** The default weekly headline follows a replacement 30-day meter in the newest snapshot. */
export function codexHeadlineWindowMinutes(rows: readonly { limit_id: string; window_minutes: number | null; ts: string }[],
  preferred: number = 10080): number {
  if (preferred !== 10080) return preferred;
  const main = rows.filter(row => row.limit_id === "codex");
  const newest = main.reduce((latest, row) => row.ts > latest ? row.ts : latest, "");
  const current = main.filter(row => row.ts === newest);
  return current.some(row => row.window_minutes === 43200) && !current.some(row => row.window_minutes === 10080) ? 43200 : preferred;
}
