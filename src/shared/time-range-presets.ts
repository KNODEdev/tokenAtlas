/** Rolling history presets shared by the screen controls; the year preset is exactly 360 days. */
export const TIME_RANGE_DAYS = [7, 14, 30, 60, 90, 180, 360] as const;
export type TimeRangeDays = typeof TIME_RANGE_DAYS[number];

export function timeRangeLabel(days: number, t: (en: string, pl: string, values?: readonly unknown[]) => string): string {
  return days === 360 ? t("360 days (year)", "360 dni (rok)") : t("{0} days", `${days} dni`, [days]);
}
