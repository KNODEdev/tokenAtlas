import type { RosterAccount } from "../api";
import { translate } from "../i18n";
import { paceColorOf, localizedNumber, freshnessLabel, localizedEmptyReason } from "./presentation";
import type { CardCore, RosterSecondWindow } from "./types";

export function glmCard(a: RosterAccount, color: string): CardCore {
  const g = a.glm;
  const head = g?.windows.find((w) => w.kind === g.headline_kind) ?? g?.windows[0] ?? null;
  const other = g?.windows.find((w) => w !== head) ?? null;
  const sp = head?.spend ?? null;
  const used = head?.percent ?? null;
  const elapsed = head?.elapsed_percent ?? null;
  const usdAt100 = sp != null && used != null && used >= 5 ? (sp.usd / used) * 100 : null;
  const second: RosterSecondWindow | null = other
    ? {
        label: other.label,
        usedPercent: other.percent,
        elapsedPercent: other.elapsed_percent,
        remainingHours: other.remaining_hours,
        note: other.note,
      }
    : null;
  const age = head?.measured_age_minutes ?? null;
  const stale = age != null && age > 30;
  return {
    id: a.id,
    vendor: a.vendor,
    plan: a.plan,
    color,
    basis: "gauge",
    percentMeasured: used != null,
    probe: null,
    percentFromProbe: true,
    estimatePercent: null,
    second,
    live: null,
    spent: used != null && used >= 100,
    usedPercent: used,
    elapsedPercent: elapsed,
    ppAhead: head?.pp_ahead ?? null,
    paceRatio: used != null && elapsed != null && elapsed > 1 ? used / elapsed : null,
    paceColor: paceColorOf(head?.pp_ahead ?? null),
    projectedEndPercent: null,
    remainingHours: head?.remaining_hours ?? null,
    resetIso: head?.reset_at ?? null,
    tokensTotal: sp ? sp.gross : null,
    tokensFresh: sp ? sp.fresh : null,
    allowanceTokens: null,
    usd: sp ? sp.usd : null,
    unpricedModels: sp?.unpriced_models ?? [],
    usdAt100,
    remainingUsd: usdAt100 != null && sp != null ? Math.max(0, usdAt100 - sp.usd) : null,
    calls: sp ? sp.calls : null,
    health: null,
    healthColor: "var(--glm)",
    confidence: used != null ? "high" : "none",
    note:
      head == null
        ? translate("no counter reading", "brak odczytu licznika")
        : stale
          ? translate(
              "counter {0} h ago",
              `licznik ${localizedNumber(age! / 60, 1)} h temu`, [localizedNumber(age! / 60, 1)],
            )
          : translate(
              "counter · {0}/{1} credits · {2}",
              `licznik · ${localizedNumber(head.used)}/${head.allowance == null ? "?" : localizedNumber(head.allowance)} kredytów · ${freshnessLabel(age!)}`, [localizedNumber(head.used), head.allowance == null ? "?" : localizedNumber(head.allowance), freshnessLabel(age!)],
            ),
    noteLong: translate(
      "The percentage is READ from the account together with its denominator: {0} of {1} credits in the {2} window. ",
      `Procent jest ODCZYTANY z konta razem z mianownikiem: ${head?.used == null ? "?" : localizedNumber(head.used)} z ${head?.allowance == null ? "?" : localizedNumber(head.allowance)} kredytów okna ${head?.label ?? "?"}. `,
      [head?.used == null ? "?" : localizedNumber(head.used), head?.allowance == null ? "?" : localizedNumber(head.allowance), head?.label ?? "?"],
    ) + translate(
      "A credit is not a token. It is weighted by model and token type, so the tokens shown beside it are a SEPARATE measure of the same work, not the denominator of this fraction. ",
      "Kredyt to nie token. Jest wa\u017Cony per model i typ tokena, wi\u0119c tokeny obok s\u0105 OSOBN\u0104 miar\u0105 tej samej pracy, nie mianownikiem tego u\u0142amka. ",
    ) + (sp ? translate(
      "Tokens ({0} calls) come from the opencode database, and dollars are API-eq from the z.ai price list: what this traffic would cost WITHOUT a subscription. ",
      `Tokeny (${localizedNumber(sp.calls)} wywołań) pochodzą z bazy opencode, a dolary są API-eq z cennika z.ai: tyle ten ruch kosztowałby BEZ abonamentu. `,
      [localizedNumber(sp.calls)],
    ) : "") + translate(
      "The account counter sees every request made with this key, while the index sees only requests through opencode. The percentage can therefore rise without a matching increase in tokens.",
      "Licznik konta widzi ka\u017Cdy ruch tym kluczem, indeks tylko ten przez opencode. Procent mo\u017Ce wi\u0119c urosn\u0105\u0107 bez wzrostu token\u00F3w.",
    ),
    emptyReason: used == null ? (localizedEmptyReason(a.empty_reason) ?? translate("no counter reading", "brak odczytu licznika")) : null,
    cycleLabel: head
      ? translate("window {0}", `okno ${head.label}`, [head.label])
      : "-",
    group: "glm",
    windowLabel: head?.label ?? null,
    shadow: null,
    model: null,
    claude: null,
    gemini: null,
    grok: null,
    glm: g,
  };
}
