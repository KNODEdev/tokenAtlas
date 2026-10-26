import type { CycleBreakdownResponse } from "./api";
import { TYPICAL_WINDOW, type CycleView } from "./cycle";

type CapWindow = Pick<CycleView, "isActive" | "isShadow" | "index" | "windowHours" | "resetIso" | "endIso" | "startIso"> & { raw: Pick<CycleView["raw"], "limit_id"> & Partial<Pick<CycleView["raw"], "work_to_ts">> };

export function previousCapWindows<T extends CapWindow>(cycles: T[], selected: CapWindow): T[] {
  return cycles.filter(c => !c.isActive && !c.isShadow && c.index !== selected.index
    && c.windowHours === selected.windowHours && c.raw.limit_id === selected.raw.limit_id
    && Date.parse(c.raw.work_to_ts ?? c.endIso) <= Date.parse(selected.startIso))
    .sort((a, b) => Date.parse(b.startIso) - Date.parse(a.startIso))
    .slice(0, TYPICAL_WINDOW);
}

export interface CapSample {
  usedPercent: number;
  data: Pick<CycleBreakdownResponse, "totals" | "unpriced" | "credit_equivalent">;
}

export function historicalWindowCaps(samples: CapSample[]) {
  const medianCap = (total: (data: CapSample["data"]) => number | null) => {
    const values = samples.flatMap(({ usedPercent, data }) => {
      const value = total(data);
      return data.totals.calls > 0 && Number.isFinite(usedPercent) && usedPercent > 0
        && value != null && Number.isFinite(value) && value >= 0 ? [value / usedPercent * 100] : [];
    }).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { value: values.length === 0 ? null : values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2, count: values.length };
  };
  return {
    api: medianCap(data => data.unpriced.tokens === 0 ? data.totals.usd : null),
    credits: medianCap(data => data.credit_equivalent?.unpriced_calls === 0 ? data.credit_equivalent.value : null),
    tokens: medianCap(data => data.totals.tokens),
  };
}
