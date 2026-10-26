import { useState } from "react";
import { Card, CardTitle, HelpBlock, Tabs } from "../components/ui";
import { duration, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { subscriptionPlan } from "../lib/subscription-plan";
import { ALL_ACCOUNT, subscriptionName, type RosterCard } from "../lib/roster";
import { endPercentAt, exhaustionIn, hoursToReset, laneOf, laneSegments, percentAt, suggestLane, type Lane } from "../lib/window-lanes";
import "./LimitWindowLanes.css";

/** Moments the projection can be read at, by the counter's length. */
function moments(horizon: number): number[] {
  const steps = horizon <= 6 ? [1, 2, 3, 4] : horizon <= 48 ? [3, 6, 12, 24] : horizon <= 200 ? [24, 48, 72, 120] : [24, 72, 168, 336];
  return [0, ...steps.filter(h => h < horizon)];
}
function axisTicks(horizon: number): number[] {
  const step = horizon <= 6 ? 1 : horizon <= 48 ? 6 : horizon <= 200 ? 24 : 168;
  const ticks: number[] = [];
  for (let h = 0; h <= horizon + 1e-9; h += step) ticks.push(h);
  return ticks;
}
/** Axis and moment labels: whole days without their zero hours. */
const offset = (h: number) => `+${h >= 24 && h % 24 === 0 ? `${h / 24}d` : duration(h)}`;
const at = (h: number, horizon: number) => `${Math.min(100, Math.max(0, (h / horizon) * 100))}%`;

export function LimitWindowLanes({ cards, windowMinutes, counterName, onSelect }: {
  cards: RosterCard[];
  windowMinutes: number;
  counterName?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const horizon = windowMinutes / 60;
  const lanes = new Map(cards.filter(c => c.id !== ALL_ACCOUNT).map(c => [c.id, laneOf(c, horizon)] as const));
  // Subscriptions without a counter follow the drawn ones, each group in roster order.
  const real = cards.filter(c => c.id !== ALL_ACCOUNT && lanes.get(c.id)).concat(cards.filter(c => c.id !== ALL_ACCOUNT && !lanes.get(c.id)));
  const options = moments(horizon);
  const [moment, setMoment] = useState(0);
  const h = options.includes(moment) ? moment : 0;
  const drawn = [...lanes.values()].filter((lane): lane is Lane => lane != null);
  const pick = suggestLane(drawn, h);
  const pickCard = pick ? real.find(c => c.id === pick.id) : undefined;
  const ticks = axisTicks(horizon);
  return (
    <Card>
      <CardTitle
        title={t("Windows of all subscriptions", "Okna wszystkich subskrypcji")}
        sub={[counterName, `${real.length} ${t("subscriptions", "subskrypcji")}`].filter(Boolean).join(" · ")}
        help={<>
          <HelpBlock>{t(
            "Each row is one subscription's current window, projected forward at its present pace. Red marks the time it would stay exhausted until its reset; later windows assume the same pace.",
            "Każdy wiersz to bieżące okno jednej subskrypcji, przedłużone w przyszłość obecnym tempem. Czerwone to czas, w którym byłoby wyczerpane aż do resetu; kolejne okna zakładają to samo tempo.",
          )}</HelpBlock>
          <HelpBlock>{t(
            "The suggestion is the paid subscription that would lose the most of its window per hour left until reset. Free subscriptions are drawn but not suggested. Percentages of different subscriptions are never added.",
            "Podpowiedź to płatna subskrypcja, która do resetu straciłaby najwięcej okna na godzinę. Darmowe są narysowane, ale nie podpowiadane. Procentów różnych subskrypcji się nie sumuje.",
          )}</HelpBlock>
        </>}
        right={<Tabs value={String(h)} onChange={v => setMoment(Number(v))}
          options={options.map(o => ({ value: String(o), label: o === 0 ? t("now", "teraz") : offset(o) }))} />}
      />
      <div className="mono lanes-suggest">
        {pick && pickCard ? <>
          <span>{t("work on", "pracuj na")}</span>
          <button type="button" onClick={() => onSelect(pick.id)}>{subscriptionName(pickCard)}</button>
          <span className="lanes-muted">
            {t("≈{0} of the window is lost at reset in {1}",
              `≈${pct(pick.lostPercent)} okna przepadnie przy resecie za ${duration(pick.resetHours)}`, [pct(pick.lostPercent), duration(pick.resetHours)])}
          </span>
        </> : <span className="lanes-muted">{t("every paid window is exhausted at this moment", "w tym momencie każde płatne okno jest wyczerpane")}</span>}
      </div>
      <div className="mono lanes-row lanes-head">
        <span>{t("subscription", "subskrypcja")}</span>
        <div className="lanes-axis">
          {ticks.map((tick, i) => (
            <span key={tick} style={{ left: at(tick, horizon), transform: i === 0 ? undefined : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
              {tick === 0 ? t("now", "teraz") : offset(tick)}
            </span>
          ))}
        </div>
        <span>{h === 0 ? t("now", "teraz") : offset(h)}</span>
      </div>
      {real.map(c => {
        const lane = lanes.get(c.id) ?? null;
        return (
          <button key={c.id} type="button" className="lanes-row lanes-body hoverline" onClick={() => onSelect(c.id)} title={lane ? c.noteLong : c.emptyReason ?? c.noteLong}>
            <span className="mono lanes-name">
              <span className="lanes-dot" style={{ background: c.color }} />
              {subscriptionName(c)}
              {c.plan && <span className="lanes-chip">{subscriptionPlan(c.vendor, c.plan)}</span>}
            </span>
            {lane ? <LaneTrack lane={lane} color={c.color} horizon={horizon} moment={h} />
              : <span className="mono lanes-muted lanes-value">{t("no counter", "brak licznika")}</span>}
            {lane ? <LaneValue lane={lane} moment={h} /> : <span className="mono lanes-muted lanes-value">—</span>}
          </button>
        );
      })}
      <div className="mono lanes-legend">
        <span><span className="lanes-swatch" style={{ background: "var(--codex)", opacity: 0.55 }} />{t("usable", "dostępne")}</span>
        <span><span className="lanes-swatch" style={{ background: "var(--crit)", opacity: 0.8 }} />{t("exhausted until reset", "wyczerpane do resetu")}</span>
        <span><span className="lanes-swatch" style={{ width: 2, background: "var(--text)" }} />{t("reset", "reset")}</span>
        <span><span className="lanes-swatch" style={{ width: 0, borderLeft: "1px dashed var(--accent)" }} />{t("chosen moment", "wybrany moment")}</span>
      </div>
    </Card>
  );
}

function LaneTrack({ lane, color, horizon, moment }: { lane: Lane; color: string; horizon: number; moment: number }) {
  const { segments, resets } = laneSegments(lane, horizon);
  return (
    <span className="lanes-track">
      {segments.map(s => (
        <span key={s.from} className="lanes-segment" data-state={s.state}
          style={{ left: at(s.from, horizon), width: at(s.to - s.from, horizon), background: s.state === "open" ? color : undefined }} />
      ))}
      {resets.map(r => <span key={r} className="lanes-reset" style={{ left: at(r, horizon) }} />)}
      <span className="lanes-moment" style={{ left: at(moment, horizon) }} />
    </span>
  );
}

function LaneValue({ lane, moment }: { lane: Lane; moment: number }) {
  const { t } = useI18n();
  const now = percentAt(lane, moment);
  const reset = hoursToReset(lane, moment);
  const left = exhaustionIn(lane, moment);
  const status = now >= 100
    ? <span style={{ color: "var(--crit)" }}>{t("exhausted", "wyczerpane")}</span>
    : left != null
      ? <span style={{ color: "var(--warn)" }}>{t("runs out in {0}", `skończy się za ${duration(left)}`, [duration(left)])}</span>
      : <span className="lanes-muted">{t("lasts · ≈{0} at reset", `starczy · ≈${pct(endPercentAt(lane, moment))} na reset`, [pct(endPercentAt(lane, moment))])}</span>;
  return (
    <span className="mono lanes-value">
      <span className="lanes-figure">{pct(now)}</span>
      <span className="lanes-muted"> · {t("reset in", "reset za")} {duration(reset)}</span>
      <br />{status}
    </span>
  );
}
