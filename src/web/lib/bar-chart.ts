/** Shared geometry of the hatched bar charts (Capacity → Before / after, Models → Cost per 1M). */

/** A step for about four grid lines: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(max: number): number {
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(factor => factor * power).find(step => raw <= step) ?? 10 * power;
}

/** A bar with rounded top corners, standing on the axis at `bottom`. */
export function barPath(x: number, y: number, width: number, bottom: number): string {
  const r = Math.min(3, width / 2, Math.max(0, bottom - y));
  return `M${x} ${bottom}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${bottom}Z`;
}

/** Approximate rendered width of Plex text, enough to keep labels apart. */
export const textWidth = (text: string, size: number, figure = false) => text.length * size * (figure ? 0.62 : 0.56);
