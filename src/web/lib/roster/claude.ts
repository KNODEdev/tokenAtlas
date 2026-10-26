import type { RosterAccount } from "../api";
import { translate } from "../i18n";
import { claudeMeterReading, claudeReading } from "../claude";
import { windowLabel, paceColorOf, localizedEmptyReason, localizedNumber } from "./presentation";
import type { CardCore } from "./types";

export function claudeCard(a: RosterAccount, color: string, nowMs: number): CardCore {
  const c = a.claude;
  const weekly = a.claude_meters?.weekly;
  const cur = a.claude_meters === undefined || weekly && c?.current?.reset_at === weekly.reset_at
    && c.current.window_start === weekly.window_start ? c?.current ?? null : null;
  const session = a.claude_meters === undefined ? c?.session : a.claude_meters.session;
  const sessionPercent = session && ("percent" in session ? session.percent : session.percent_measured);
  const reading = weekly ? claudeMeterReading(weekly, nowMs) : claudeReading(cur);
  const used = reading.percentAll;
  const elapsed = weekly?.elapsed_percent ?? cur?.elapsed_percent ?? null;
  const ppAhead = reading.ppAhead;
  return {
    id: a.id,
    vendor: a.vendor,
    plan: a.plan,
    color,
    basis: "declared",
    percentMeasured: reading.measured,
    probe: null,
    // An estimate from indexed traffic survives a probe outage; only a
    // measured reading is the probe's to take away.
    percentFromProbe: reading.measured,
    estimatePercent: null,
    second:
      session && sessionPercent != null
        ? {
            label: windowLabel(5 * 60),
            usedPercent: sessionPercent,
            elapsedPercent: session.elapsed_percent,
            remainingHours: session.remaining_hours,
            note: null,
          }
        : null,
    live: null,
    spent: false,
    usedPercent: used,
    elapsedPercent: elapsed,
    ppAhead,
    paceRatio: reading.paceRatio,
    paceColor: paceColorOf(ppAhead),
    projectedEndPercent: cur?.projected_end_percent ?? null,
    remainingHours: weekly?.remaining_hours ?? cur?.remaining_hours ?? null,
    resetIso: weekly?.reset_at ?? cur?.reset_at ?? null,
    tokensTotal: cur?.spend.gross ?? null,
    tokensFresh: cur?.spend.fresh ?? null,
    allowanceTokens: null,
    usd: cur?.spend.usd ?? null,
    unpricedModels: cur?.unpriced_models ?? [],
    usdAt100: c?.window_value_usd ?? null,
    remainingUsd: cur?.remaining_usd ?? null,
    calls: cur?.spend.calls ?? null,
    health: null,
    healthColor: "var(--accent)",
    confidence: c?.confidence ?? "none",
    note: reading.measured ? reading.note : translate("no gauge · inferred", "brak gauge · wywnioskowane"),
    noteLong: [
      reading.noteLong,
      c?.calibration_reason ??
        translate(
          "Claude does not provide a percentage with calls. It is read from the account; claude-gauge.json supplies the cap and point cost.",
          "Claude nie podaje procentu przy wywołaniach — jest odczytywany z konta; z claude-gauge.json pochodzą pułap i koszt punktu.",
        ),
    ]
      .filter(Boolean)
      .join(" "),
    emptyReason: weekly || cur ? null : localizedEmptyReason(a.empty_reason),
    cycleLabel: c?.window_hours
      ? translate(
          "window {0}d",
          `okno ${localizedNumber(c.window_hours / 24)}d`, [localizedNumber(c.window_hours / 24)],
        )
      : translate("weekly window", "okno tygodniowe"),
    group: "claude",
    windowLabel: null,
    shadow: null,
    model: null,
    claude: a.claude,
    gemini: null,
    grok: null,
    glm: null,
    creditPools: c?.credit_pools ?? null,
  };
}
