import type { RosterAccount } from "../api";
import { translate } from "../i18n";
import { freshnessLabel, paceColorOf, localizedNumber, localizedEmptyReason } from "./presentation";
import type { CardCore } from "./types";
import { usageWindowNumbers } from "./window-numbers";

export function grokCard(a: RosterAccount, color: string): CardCore {
  const w = a.grok;
  const spend = w?.spend ?? null;
  const stale = w?.age_hours ?? null;
  const limit = w?.limit ?? null;
  const cal = limit?.calibration ?? null;
  const current = limit?.current ?? null;
  const measured = current?.percent_measured ?? null;
  // The server nulls percent_est when the window holds no indexed traffic, so an
  // estimate here always has something behind it. It stays out of usedPercent:
  // an inferred number must never be read as an account reading.
  const estimate = measured == null ? current?.percent_est ?? null : null;
  const used = measured;
  const gauge = usageWindowNumbers({
    usedPercent: used,
    startsAt: current?.anchored ? current.window_start : null,
    resetsAt: current?.anchored ? current.window_end : null,
    windowMinutes: limit ? limit.window_hours * 60 : null,
  });
  const idleHours = current?.idle_hours ?? null;
  const measuredAge = current?.measurement_age_minutes ?? null;
  const measuredFresh = measuredAge == null
    ? null
    : freshnessLabel(measuredAge);
  return {
    id: a.id,
    vendor: a.vendor,
    plan: a.plan,
    color,
    basis: "declared",
    percentMeasured: measured != null,
    probe: null,
    percentFromProbe: true,
    estimatePercent: estimate,
    second: null,
    live: null,
    spent: used != null && used >= 100,
    usedPercent: used,
    elapsedPercent: gauge.elapsed,
    ppAhead: gauge.ppAhead,
    paceRatio: gauge.paceRatio,
    paceColor: paceColorOf(gauge.ppAhead),
    projectedEndPercent: null,
    remainingHours: gauge.remainingHours,
    resetIso: gauge.resetIso,
    tokensTotal: spend?.gross ?? null,
    tokensFresh: spend?.fresh ?? null,
    allowanceTokens: null,
    usd: spend?.usd ?? null,
    // Grok amounts are the vendor's own money, not a rate-card valuation.
    unpricedModels: [],
    usdAt100: cal?.window_value_usd ?? null,
    remainingUsd: limit?.current?.remaining_usd ?? null,
    calls: spend?.calls ?? null,
    health: null,
    healthColor: "var(--faint)",
    confidence: measured != null ? "high" : cal?.confidence === "medium" ? "medium" : cal ? "low" : "none",
    note: measured != null
      ? translate(
          "Billing · {0}",
          `Billing · ${measuredFresh ?? "odczyt konta"}`, [measuredFresh ?? "account reading"],
        )
      : estimate != null
        ? translate(
            "estimate{0}",
            `szacunek${cal ? ` · $${localizedNumber(cal.usd_per_point, 2)}/pkt` : ""}`, [cal ? ` · $${localizedNumber(cal.usd_per_point, 2)}/point` : ""],
          )
        : spend == null || spend.turns === 0
          ? translate("no Billing reading or turns", "brak odczytu Billing i tur")
          : stale != null && stale > 48
            ? translate(
                "last turn {0} days ago",
                `ostatnia tura ${localizedNumber(stale / 24)} dni temu`, [localizedNumber(stale / 24)],
              )
            : translate(
                "{0} turns · {1} calls",
                `${localizedNumber(spend.turns)} tur · ${localizedNumber(spend.calls)} wywołań`, [localizedNumber(spend.turns), localizedNumber(spend.calls)],
              ),
    noteLong:
      (measured != null
        ? translate("Percentage {0}% and reset are READ from Billing saved by the official Grok CLI{1}. ", `Procent ${localizedNumber(measured)}% i reset są ODCZYTANE z Billing zapisanego przez oficjalny CLI Groka${measuredFresh ? ` (${measuredFresh})` : ""}. `, [localizedNumber(measured), measuredFresh ? ` (${measuredFresh})` : ""]) + (current?.percent_est != null ? translate("Local cost would give {0}%. This difference is expected because the account also sees traffic outside the index. ", `Lokalny koszt dawałby ${localizedNumber(current.percent_est, 1)}% — ta różnica jest oczekiwana, bo konto widzi także ruch spoza indeksu. `, [localizedNumber(current.percent_est, 1)]) : "")
        : estimate != null
          ? translate("No Billing reading. {0}% is an ESTIMATE from indexed traffic in this window{1}; traffic outside the local index may make it low. ", `Brak odczytu Billing. ${localizedNumber(estimate, 1)}% to SZACUNEK z zaindeksowanego ruchu w tym oknie${cal ? `, w skali $${localizedNumber(cal.usd_per_point, 2)}/punkt` : ""}; może zaniżać ruch spoza lokalnego indeksu. `, [localizedNumber(estimate, 1), cal ? translate(", at ${0}/point", `, w skali $${localizedNumber(cal.usd_per_point, 2)}/punkt`, [localizedNumber(cal.usd_per_point, 2)]) : ""]) + (idleHours != null && idleHours > 24 ? translate("The last CLI turn was {0} days ago. ", `Ostatnia tura CLI była ${localizedNumber(idleHours / 24)} dni temu. `, [localizedNumber(idleHours / 24)]) : "")
          : translate(
              "No Billing reading, and this window has no indexed traffic from which an estimate could be calculated. ",
              "Brak odczytu Billing, a w tym oknie nie ma zaindeksowanego ruchu, z którego dałoby się wyliczyć szacunek. ",
            )) +
      translate(
        "Tokens and dollars come from local sessions; dollars are the vendor's own valuation (costUsdTicks), not the API price list used by tokenAtlas.",
        "Tokeny i dolary pochodzą z lokalnych sesji; dolary to własna wycena vendora (costUsdTicks), nie cennik API zastosowany przez tokenAtlas.",
      ),
    emptyReason:
      used != null || estimate != null || (spend && spend.turns > 0)
        ? null
        : (localizedEmptyReason(a.empty_reason) ?? translate("no data in this window", "brak danych w tym oknie")),
    cycleLabel: current?.anchored
      ? translate(
          "window {0}d",
          `okno ${localizedNumber(limit!.window_hours / 24)}d`, [localizedNumber(limit!.window_hours / 24)],
        )
      : w
        ? translate(
            "rolling {0}d",
            `krocząco ${localizedNumber(w.window_hours / 24)}d`, [localizedNumber(w.window_hours / 24)],
          )
        : "—",
    group: "grok",
    windowLabel: current?.anchored
      ? `${localizedNumber(limit!.window_hours / 24)}d`
      : w
        ? translate("rolling", "kroczące")
        : null,
    shadow: null,
    model: null,
    claude: null,
    gemini: null,
    grok: w,
    glm: null,
  };
}
