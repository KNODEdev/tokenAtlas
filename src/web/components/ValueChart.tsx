import type { CSSProperties } from "react";
import { useI18n } from "../lib/i18n";
import { ChartExport } from "./ChartExport";

/** One bar: what one paid dollar bought (used) and could have bought (capacity), in the vendor's ink. */
export interface ValueBar {
  key: string; label: string; sub?: string; color: string;
  used: number | null; capacity: number | null;
  usedTitle?: string; capacityTitle?: string;
  selected?: boolean; onSelect?: () => void;
}

/** A scale top rounded up to 1, 2 or 5 × 10ⁿ. */
function niceTop(value: number): number {
  if (!(value > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((factor) => factor * step).find((top) => top >= value)!;
}

/**
 * Value → Billing periods (user decision 21.10): one horizontal bar per table row, used per $1 solid over the capacity
 * per $1 washed in the same vendor ink; `reference` draws the 1× line (paying API prices) in API $.
 */
export function ValueChart({ bars, title, format, reference, legend }: {
  bars: ValueBar[]; title: string; format: (value: number | null) => string; reference?: number;
  legend: Array<{ label: string; color: string }>;
}) {
  const { t } = useI18n();
  // A row with neither figure has nothing to draw; the table still lists it.
  bars = bars.filter((bar) => bar.used !== null || bar.capacity !== null);
  const top = niceTop(Math.max(reference ?? 0, ...bars.flatMap((bar) => [bar.used ?? 0, bar.capacity ?? 0])));
  const at = (value: number) => `${Math.min(100, Math.max(0, value / top * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * top);
  return <ChartExport title={title}><figure className="value-chart" aria-label={title} data-value-chart>
    <figcaption className="value-chart-legend">
      {legend.map((entry) => <span key={entry.label}><i className="capacity-swatch" style={{ background: entry.color }} />{entry.label}</span>)}
      <span><i className="value-chart-key is-used" />{t("used", "zużyte")}</span>
      <span><i className="value-chart-key is-capacity" />{t("unused capacity", "niewykorzystana pojemność")}</span>
      {reference !== undefined && <span><i className="value-chart-key is-reference" />{t("1× = API prices", "1× = ceny API")}</span>}
    </figcaption>
    <div className="value-chart-rows">
      {bars.map((bar) => <div key={bar.key} className={`value-chart-row${bar.selected ? " is-selected" : ""}${bar.onSelect ? " is-selectable" : ""}`}
        style={{ "--value-ink": bar.color } as CSSProperties} onClick={bar.onSelect} data-value-bar={bar.key}>
        <span className="value-chart-label"><span>{bar.label}</span>{bar.sub && <span className="value-chart-sub">{bar.sub}</span>}</span>
        <span className="value-chart-track">
          {bar.capacity !== null && <span className="value-chart-capacity" style={{ width: at(bar.capacity) }} title={bar.capacityTitle} />}
          {bar.used !== null && <span className="value-chart-used" style={{ width: at(bar.used) }} title={bar.usedTitle} />}
          {reference !== undefined && <span className="value-chart-reference" style={{ left: at(reference) }} />}
        </span>
        <span className="value-chart-figure mono" title={[bar.usedTitle, bar.capacityTitle].filter(Boolean).join("\n") || undefined}>
          <strong>{format(bar.used)}</strong> <span>/ {format(bar.capacity)}</span></span>
      </div>)}
      <div className="value-chart-axis" aria-hidden="true">
        <span />
        <span className="value-chart-ticks">{ticks.map((tick) => <span key={tick} style={{ left: at(tick) }}>{format(tick)}</span>)}</span>
        <span />
      </div>
    </div>
  </figure></ChartExport>;
}
