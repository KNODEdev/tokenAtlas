import type { ContextPreviewResponse } from "./context-preview";
/**
 * Estimated division of a window's limit meter between models. The meter readings and each model's stored API
 * value are facts; the split between models is an allocation, never a measured per-model meter.
 */
export const MODEL_USAGE_SHARE_TRAILING_HOURS = 3;
const HOUR = 3_600_000;

export interface ModelUsageShareInput {
  start: number; end: number;
  /** The last instant with data: the window end, or now for the current window. */
  stop: number;
  /** Highest meter percent per UTC hour start. */
  meter: ReadonlyArray<readonly [number, number]>;
  /** Counted traffic per model: its stored API Standard value and tokens per UTC hour start. */
  models: ReadonlyArray<{ api_usd: number; hours: ReadonlyArray<readonly [number, number]>;
    /** Companion: preserve the existing base allocation and add exact saved hour uplifts. */
    hour_api?: ReadonlyArray<readonly [number, number]> }>;
}
export interface ModelUsageShareWindow {
  window_id: string; start: string; end: string; plan: string | null; current: boolean;
  /** No stored window sums yet, or newer facts are being prepared; the last publication stays visible. */
  preparing: boolean;
  /** Highest meter reading of the window; null without readings. */
  meter: number | null;
  /** Counted traffic by model, ordered as `ModelUsageShareResponse.models`; zero where a model had none. */
  pct: number[]; api_usd: number[]; unattributed_pct: number;
}
export interface ModelUsageShareResponse extends ContextPreviewResponse<ModelUsageShareResponse> {
  provider: "codex" | "claude"; account: string; counter: string; since: string; until: string;
  preparing_windows: number;
  /** Models of the range, highest API value first. */
  models: Array<string | null>;
  windows: ModelUsageShareWindow[];
  /** The chosen window (the requested one, else the latest) hour by hour. */
  detail: { window_id: string; points: Array<{ t: string; meter: number; pct: number[]; api_usd: number[]; unattributed: number }> } | null;
}

/** Running totals at `t`: the meter, each model's allocated percent and API value (input order), and the unexplained rest. */
export interface ModelUsageSharePoint { t: number; meter: number; pct: number[]; api_usd: number[]; unattributed: number }

/**
 * Hour by hour, the meter increase follows that hour's API value shares. A model's stored API value is spread over
 * its hourly tokens, so prices are never recomputed. An increase without priced traffic in its hour uses the
 * preceding hours, then the window so far; anything still unexplained stays unattributed. A window starts at 0%,
 * so a first reading above it belongs to its first minutes.
 */
export function modelUsageShare(input: ModelUsageShareInput): ModelUsageSharePoint[] {
  const count = input.models.length, zeros = () => new Array<number>(count).fill(0);
  const hourly = new Map<number, number[]>();
  input.models.forEach((model, index) => {
    if (model.hour_api) {
      for (const [hour,value] of model.hour_api) {
        const row=hourly.get(hour)??zeros();row[index]!+=value;hourly.set(hour,row);
      }
      return;
    }
    const tokens = model.hours.reduce((sum, [, value]) => sum + value, 0);
    const price = tokens > 0 && model.api_usd > 0 ? model.api_usd / tokens : 0;
    for (const [hour, value] of model.hours) {
      const row = hourly.get(hour) ?? zeros();
      row[index]! += value * price;
      hourly.set(hour, row);
    }
  });
  const meter = [...input.meter].sort((a, b) => a[0] - b[0]);
  const pct = zeros(), api = zeros();
  let unattributed = 0, previous = 0, top = 0, next = 0;
  const points: ModelUsageSharePoint[] = [{ t: input.start, meter: 0, pct: zeros(), api_usd: zeros(), unattributed: 0 }];
  const recent: number[][] = [];
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  for (let hour = Math.floor(input.start / HOUR) * HOUR; hour < input.stop; hour += HOUR) {
    while (next < meter.length && meter[next]![0] <= hour) top = Math.max(top, meter[next++]![1]);
    const row = hourly.get(hour) ?? zeros(), delta = Math.max(0, top - previous);
    previous = Math.max(previous, top);
    row.forEach((value, index) => { api[index]! += value; });
    recent.push(row);
    if (recent.length > MODEL_USAGE_SHARE_TRAILING_HOURS) recent.shift();
    const trailing = zeros();
    for (const values of recent) values.forEach((value, index) => { trailing[index]! += value; });
    const weights = [row, trailing, api].find(values => sum(values) > 0);
    if (delta > 0) {
      if (weights) { const total = sum(weights); weights.forEach((value, index) => { pct[index]! += delta * value / total; }); }
      else unattributed += delta;
    }
    points.push({ t: Math.min(hour + HOUR, input.stop), meter: previous, pct: [...pct], api_usd: [...api], unattributed });
  }
  return points;
}
