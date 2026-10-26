import { useEffect, useState } from "react";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../../shared/time-range-presets";
import { Field, HelpBlock, HelpDot, Selector, Tabs } from "../../components/ui";
import { useI18n } from "../../lib/i18n";
import type { Translate } from "./format";

function rangeOptions(t: Translate): Array<{ value: string; label: string; title: string }> {
  return [...TIME_RANGE_DAYS.map(days => ({ value: String(days), label: timeRangeLabel(days, t),
    title: t("Traffic from the calendar date {0} days ago (date >= since)", `Ruch od daty kalendarzowej sprzed ${days} dni (data >= since)`, [days]) })),
    { value: "all", label: t("All", "Całość"), title: t("All recorded history without a date filter", "Cała zarejestrowana historia (bez filtra daty)") }];
}
const IDLE_GAPS = [5, 10, 15, 30, 45, 60];
export function sinceOf(range: string, nowMs: number): string | undefined {
  if (range === "all") return undefined;
  const days = Number(range);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
}
function msUntilNextUtcMidnight(nowMs: number): number {
  const t = new Date(nowMs);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) - nowMs;
}
export function useUtcNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const arm = () => {
      if (cancelled) return;
      const delay = Math.max(msUntilNextUtcMidnight(Date.now()), 1);
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowMs(Date.now());
        arm();
      }, delay);
    };
    arm();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return nowMs;
}
export function Controls({
  range,
  setRange,
  idleGap,
  setIdleGap,
  pending,
}: {
  range: string;
  setRange: (r: string) => void;
  idleGap: number;
  setIdleGap: (n: number) => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="ui-toolbar">
        <Field label={t("Range", "Zakres")}>
          <Tabs value={range} onChange={setRange} options={rangeOptions(t)} />
        </Field>
        <Field label={t("Idle gap", "Próg przerwy")}>
          <Selector ariaLabel={t("Idle threshold in minutes", "Próg bezczynności w minutach")} value={String(idleGap)}
            onChange={(value) => setIdleGap(Number(value))} options={IDLE_GAPS.map((v) => ({ value: String(v), label: `${v} min` }))} />
          <HelpDot label={t("Idle gap", "Próg przerwy")}>
            <HelpBlock>{t(
              "Session time is an estimate, not a clock reading: the sum of gaps between consecutive calls in one session, each capped at this threshold.",
              "Czas sesji jest szacunkiem, nie odczytem zegara: to suma przerw między kolejnymi wywołaniami w obrębie jednej sesji, każda przycięta tym progiem.",
            )}</HelpBlock>
            <HelpBlock>{t(
              "The first four ranking positions keep their order at 5, 15, 30 and 60 minutes; changes start from fifth place. The total can change by about 46% across this range.",
              "Pierwsza czwórka rankingu trzyma kolejność przy 5, 15, 30 i 60 minutach; zamiany zaczynają się od piątego miejsca. Suma potrafi się zmienić o ~46% w tym zakresie.",
            )}</HelpBlock>
          </HelpDot>
        </Field>
        {pending && <span className="projects-faint">{t("recalculating…", "przeliczam…")}</span>}
    </div>
  );
}
