import type { ClaudeCurrentWindow } from "./api";
import type { RosterMeter } from "../../shared/roster-meters";
import { getLocale, translate } from "./i18n";
export interface ClaudeReading {
  percentAll: number | null;
  percentFable: number | null;
  measured: boolean;
  fableMeasured: boolean;
  ageMinutes: number | null;
  estAll: number | null;
  estFable: number | null;
  gapPp: number | null;
  remainingPercent: number | null;
  ppAhead: number | null;
  paceRatio: number | null;
  note: string;
  noteLong: string;
}
function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
function emptyClaudeReading(): ClaudeReading {
  return {
    percentAll: null,
    percentFable: null,
    measured: false,
    fableMeasured: false,
    ageMinutes: null,
    estAll: null,
    estFable: null,
    gapPp: null,
    remainingPercent: null,
    ppAhead: null,
    paceRatio: null,
    note: translate("no window", "brak okna"),
    noteLong: translate(
      "This account does not have a current weekly window yet.",
      "Dla tego konta nie ma jeszcze bieżącego okna tygodniowego.",
    ),
  };
}
function freshness(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes < 1) return translate("just now", "przed chwilą");
  if (minutes < 60) {
    const value = localizedNumber(minutes, 0);
    return translate("{0} min ago", `${value} min temu`, [value]);
  }
  const value = localizedNumber(minutes / 60, 1);
  return translate("{0} h ago", `${value} h temu`, [value]);
}
export function claudeReading(cur: ClaudeCurrentWindow | null | undefined): ClaudeReading {
  if (!cur) return emptyClaudeReading();
  const measured = cur.percent_all_measured != null;
  const percentAll = cur.percent_all_measured ?? cur.percent_all_est;
  const fableMeasured = cur.percent_fable_measured != null;
  const percentFable = cur.percent_fable_measured ?? cur.percent_fable_est;
  const gapPp =
    cur.percent_all_measured != null && cur.percent_all_est != null
      ? cur.percent_all_est - cur.percent_all_measured
      : null;
  const elapsed = cur.elapsed_percent;
  // After an in-window drop an even pace runs from the first reading's percent to 100% at the reset.
  const baseline = cur.counter_reset?.first_after.percent ?? 0;
  const room = 100 - baseline;
  const ppAhead = percentAll != null ? percentAll - (baseline + (room * elapsed) / 100) : null;
  const paceRatio = percentAll != null && elapsed > 1 && room > 0 ? (percentAll - baseline) / ((room * elapsed) / 100) : null;
  const age = measured ? cur.measured_age_minutes : null;
  const note = measured
    ? translate("account · {0}", `konto · ${freshness(age)}`, [freshness(age)])
    : translate("from index · inferred", "z indeksu · wywnioskowane");
  const estimatedPercent = cur.percent_all_est == null ? null : localizedNumber(cur.percent_all_est, 1);
  const gap = gapPp == null ? null : localizedNumber(Math.abs(gapPp), 1);
  const noteLong = measured
    ? translate("Percentage read from the account (GET /api/oauth/usage) {0}.", `Procent odczytany z konta (GET /api/oauth/usage) ${freshness(age)}.`, [freshness(age)]) + (gapPp != null && Math.abs(gapPp) > 2 ? translate(" The index estimates {0}% ({1}{2} pp). The difference is usage outside the index or a stale point cost.", ` Indeks liczy ${estimatedPercent}% (${gapPp > 0 ? "+" : "−"}${gap} pp) — różnica to zużycie spoza indeksu albo nieaktualny koszt punktu.`, [estimatedPercent, gapPp > 0 ? "+" : "−", gap]) : "")
    : translate(
        "The account did not respond for this window. The percentage is calculated from measured usage and the point cost from claude-gauge.json.",
        "Konto nie odpowiedziało dla tego okna — procent policzony ze zmierzonego zużycia i kosztu punktu z claude-gauge.json.",
      );
  return {
    percentAll,
    percentFable,
    measured,
    fableMeasured,
    ageMinutes: age,
    estAll: cur.percent_all_est,
    estFable: cur.percent_fable_est,
    gapPp,
    remainingPercent: percentAll != null ? Math.max(0, 100 - percentAll) : null,
    ppAhead,
    paceRatio,
    note,
    noteLong,
  };
}

/** A real committed reading remains usable while analytical sums are preparing. */
export function claudeMeterReading(meter: RosterMeter, nowMs: number): ClaudeReading {
  const age = Math.max(0, (nowMs - Date.parse(meter.measured_at)) / 60_000);
  const baseline = meter.baseline_percent;
  const expected = baseline == null ? null : (100 - baseline) * meter.elapsed_percent / 100;
  return {
    percentAll: meter.percent, percentFable: null, measured: true, fableMeasured: false,
    ageMinutes: age, estAll: null, estFable: null, gapPp: null,
    remainingPercent: Math.max(0, 100 - meter.percent),
    ppAhead: baseline != null && expected != null ? meter.percent - baseline - expected : null,
    paceRatio: baseline != null && meter.elapsed_percent > 1 && expected != null && expected > 0 ? (meter.percent - baseline) / expected : null,
    note: translate("account · {0}", `konto · ${freshness(age)}`, [freshness(age)]),
    noteLong: translate("Percentage read from the account at {0}.", `Procent odczytany z konta: ${meter.measured_at}.`, [meter.measured_at]),
  };
}
