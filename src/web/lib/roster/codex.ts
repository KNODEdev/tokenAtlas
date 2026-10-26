import type { RosterAccount } from "../api";
import { currentPointBasis, creditBasisOf } from "../current-point-basis";
import { buildModel, emptySeries, healthColor } from "../cycle";
import { translate } from "../i18n";
import { windowLabel, gaugeNote, paceColorOf, localizedEmptyReason } from "./presentation";
import type { RosterSecondWindow, CardCore } from "./types";
import { liveNumbers, liveNote } from "./window-numbers";

function codexSecondWindow(a: RosterAccount): RosterSecondWindow | null {
  const other = a.live_other.find(
    (row) =>
      row.limit_id === "codex" &&
      row.window_minutes != null &&
      row.window_minutes !== a.live?.window_minutes
  );
  if (!other || other.window_minutes == null) return null;
  const nums = liveNumbers(other);
  return {
    label: windowLabel(other.window_minutes),
    usedPercent: nums.used,
    elapsedPercent: nums.elapsed,
    remainingHours: nums.remainingHours,
    note: other.rate_limit_reached ? translate("limit exhausted", "limit wyczerpany") : null,
  };
}
export function gaugeCard(a: RosterAccount, color: string, windowMinutes: number): CardCore {
  const live = a.live;
  const minutes = live?.window_minutes ?? windowMinutes;
  const cycles = a.cycles.filter(cycle => cycle.window_hours * 60 === minutes);
  const pointBasis = currentPointBasis(cycles);
  const model = cycles.length > 0 || live ? buildModel(emptySeries(a.id, minutes, cycles), live) : null;
  const nums = live ? liveNumbers(live) : null;
  const cur = model?.current ?? null;
  const hasIndexedCurrent = (cur?.raw.sample_count ?? 0) > 0;
  const cal = cur?.calibration.allowanceTokens != null ? cur.calibration : model?.bestCalibration ?? null;
  const note = live ? liveNote(live) : gaugeNote(a.gauge_age_hours);
  const usedPercent = cur?.usedPercent ?? nums?.used ?? null;
  const elapsedPercent = cur?.elapsedPercent ?? nums?.elapsed ?? null;
  const ppAhead =
    usedPercent != null && elapsedPercent != null ? usedPercent - elapsedPercent : cur?.ppAhead ?? null;
  const paceRatio =
    usedPercent != null && elapsedPercent != null && elapsedPercent > 0
      ? usedPercent / elapsedPercent
      : cur?.paceRatio ?? null;
  const gaugeUsdAt100 = pointBasis?.usd ?? null;
  return {
    id: a.id,
    vendor: a.vendor,
    plan: a.plan,
    color,
    basis: "gauge",
    percentMeasured: usedPercent != null,
    probe: null,
    percentFromProbe: !hasIndexedCurrent,
    estimatePercent: null,
    second: codexSecondWindow(a),
    live,
    spent: live?.rate_limit_reached ?? false,
    usedPercent,
    elapsedPercent,
    ppAhead,
    paceRatio,
    paceColor: paceColorOf(ppAhead),
    projectedEndPercent: cur?.projectedEndPercent ?? null,
    remainingHours: cur?.remainingHours ?? nums?.remainingHours ?? null,
    resetIso: cur?.resetIso ?? nums?.resetIso ?? null,
    tokensTotal: hasIndexedCurrent ? cur?.tokensTotal ?? null : null,
    tokensFresh: hasIndexedCurrent ? cur?.tokensFresh ?? null : null,
    allowanceTokens: cal?.allowanceTokens ?? null,
    usd: hasIndexedCurrent ? cur?.usd ?? null : null,
    unpricedModels: hasIndexedCurrent ? cur?.raw.unpriced_models ?? [] : [],
    usdAt100: gaugeUsdAt100,
    remainingUsd: gaugeUsdAt100 != null && hasIndexedCurrent && usedPercent != null
      ? gaugeUsdAt100 * Math.max(0, 1 - usedPercent / 100) : null,
    calls: hasIndexedCurrent ? cur?.calls ?? null : null,
    health: cur?.health ?? null,
    healthColor: cur ? healthColor(cur.health) : "var(--faint)",
    confidence: cal?.confidence ?? "none",
    note: note.short,
    noteLong: [note.long, a.note].filter(Boolean).join(" "),
    emptyReason: cur
      ? null
      : localizedEmptyReason(a.empty_reason) ?? translate("no active cycle in this window", "brak aktywnego cyklu w tym oknie"),
    cycleLabel: cur?.label ?? "—",
    group: "codex",
    windowLabel: minutes === 43200 ? windowLabel(minutes) : null,
    shadow: a.shadow,
    model,
    claude: null,
    gemini: null,
    grok: null,
    glm: null,
    creditPools: cur?.raw.credit_pools ?? null,
    pointBasis,
    creditBasis: creditBasisOf(pointBasis),
    creditFunded: cur?.raw.credit_funded ?? null,
  };
}
