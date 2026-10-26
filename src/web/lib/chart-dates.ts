const DAY = 86_400_000;

export function chartDateFormatter(locale: string, from: number, until: number, withTime = false) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", day: "2-digit", month: "2-digit",
    year: new Date(from).getUTCFullYear() !== new Date(until).getUTCFullYear() ? "2-digit" : undefined,
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  });
}

/** One dated label per UTC day; sub-day histories retain their clock times. */
export function calendarDateLabels(isos: readonly (string | null | undefined)[], locale: string): (string | null)[] {
  const times = isos.map(iso => typeof iso === "string" ? Date.parse(iso) : NaN);
  const valid = times.filter(Number.isFinite);
  const from = Math.min(...valid), until = Math.max(...valid);
  const format = chartDateFormatter(locale, from, until, until > from && until - from < DAY);
  let previous = "";
  return times.map(time => {
    if (!Number.isFinite(time)) return null;
    const label = format.format(time);
    if (label === previous) return null;
    previous = label;
    return label;
  });
}

/** Calendar ticks use the same continuous time scale as the plotted data. */
export function calendarTimeTicks(from: number, until: number, width: number, locale: string, withTime = false): { time: number; label: string }[] {
  if (!Number.isFinite(from) || !Number.isFinite(until) || until < from || width <= 0) return [];
  const span = until - from;
  const format = chartDateFormatter(locale, from, until, withTime || span < DAY);
  if (!span) return [{ time: from, label: format.format(from) }];
  const gap = Math.max(format.format(from).length, format.format(until).length) * 6 + 18;
  const slots = Math.max(1, Math.floor(width / gap));
  const target = span / slots;
  const interval = span < DAY || withTime
    ? [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, DAY].find(step => step >= target) ?? Math.ceil(target / DAY) * DAY
    : Math.max(1, Math.ceil(target / DAY)) * DAY;
  const minDistance = span * gap / width;
  const result = [{ time: from, label: format.format(from) }];
  for (let time = Math.ceil(from / interval) * interval; time < until; time += interval) {
    const last = result.at(-1)!;
    const label = format.format(time);
    if (time - last.time >= minDistance && label !== last.label) result.push({ time, label });
  }
  const label = format.format(until);
  if (label !== result.at(-1)!.label) {
    if (result.length > 1 && until - result.at(-1)!.time < minDistance) result.pop();
    result.push({ time: until, label });
  }
  return result;
}
