const DAY = 86_400_000;
/** Consecutive UTC days, with label density matched to the available desktop width. */
export function speedDayAxis(from: string, until: string, width: number, challenge?: { from: string; days: number }) {
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ticks: [], labels: [] };
  const count = Math.round((end - start) / DAY) + 1;
  const years = from.slice(0, 4) !== until.slice(0, 4);
  const capacity = Math.max(2, 1 + Math.floor(Math.max(0, width) / (years ? 57 : 32)));
  const stride = Math.max(1, Math.ceil((count - 1) / (capacity - 1)));
  const challengeStart = challenge ? Date.parse(`${challenge.from}T00:00:00Z`) : NaN;
  const ticks = Array.from({ length: count }, (_, index) => {
    const at = new Date(start + index * DAY).toISOString().slice(0, 10);
    const day = Math.round((start + index * DAY - challengeStart) / DAY) + 1;
    return { at, label: `${at.slice(8)}.${at.slice(5, 7)}${years ? `.${at.slice(2, 4)}` : ""}`,
      day: challenge && day >= 1 && day <= challenge.days ? day : null };
  });
  const labels = ticks.filter((_, index) => index % stride === 0);
  if (labels.at(-1)?.at !== until) {
    if (labels.length > 1 && (count - 1) % stride < stride / 2) labels.pop();
    labels.push(ticks.at(-1)!);
  }
  return { ticks: count <= Math.max(2, width / 4) ? ticks : labels, labels };
}
