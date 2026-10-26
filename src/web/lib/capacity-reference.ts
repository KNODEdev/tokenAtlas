export interface CapacityReference { percent: number; cycleId: string | null }
export interface ReferenceCandidate { id: string; value: number }
/** `compare` is the optional second line of the same measure, read against the first. */
export interface SavedCapacityReference extends CapacityReference { badgePosition: number | null; compare: CapacityReference | null }

export function readCapacityReference(key: string, initialPercent: number): SavedCapacityReference {
  const fallback = { percent: initialPercent, cycleId: null, badgePosition: null, compare: null };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const line = storedLine(value);
    if (!line) return fallback;
    return { ...line,
      badgePosition: typeof value.badgePosition === "number" && Number.isFinite(value.badgePosition) ? Math.max(0, Math.min(1, value.badgePosition)) : null,
      compare: storedLine(value.compare) };
  } catch { return fallback; }
}

function storedLine(value: unknown): CapacityReference | null {
  if (!value || typeof value !== "object") return null;
  const { percent, cycleId } = value as { percent?: unknown; cycleId?: unknown };
  if (typeof percent !== "number" || !Number.isFinite(percent) || (cycleId !== null && typeof cycleId !== "string")) return null;
  return { percent: referencePercent(percent), cycleId };
}

export function saveCapacityReference(key: string, value: SavedCapacityReference) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep interaction available when browser storage is disabled. */ }
}

export function referencePercent(value: number): number {
  return Math.max(1, Math.min(100, Number.isFinite(value) ? value : 1));
}

export function resolveReference(reference: CapacityReference, candidates: ReferenceCandidate[], maximum: number) {
  const pinned = candidates.find(candidate => candidate.id === reference.cycleId);
  const value = pinned?.value ?? maximum * reference.percent / 100;
  return { pinned, value, percent: referencePercent(maximum > 0 ? value / maximum * 100 : 1) };
}

export function snapReference(percent: number, candidates: ReferenceCandidate[], maximum: number, pixels: number): CapacityReference {
  const bounded = referencePercent(percent);
  const nearest = candidates.filter(candidate => candidate.value >= maximum * .01 && candidate.value <= maximum)
    .reduce<ReferenceCandidate | undefined>((best, candidate) => !best || Math.abs(candidate.value / maximum * 100 - bounded) < Math.abs(best.value / maximum * 100 - bounded) ? candidate : best, undefined);
  if (maximum > 0 && pixels > 0 && nearest && Math.abs(nearest.value / maximum * 100 - bounded) * pixels / 100 <= 8) {
    return { percent: nearest.value / maximum * 100, cycleId: nearest.id };
  }
  return { percent: bounded, cycleId: null };
}

/** The second line minus the first, at 100% and relative to the first. */
export function referenceDifference(reference: number, compared: number) {
  const value = compared - reference;
  return { value, relative: reference > 0 ? value / reference * 100 : null };
}
