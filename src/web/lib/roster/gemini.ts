import type { RosterAccount, GeminiWindow } from "../api";
import { translate } from "../i18n";
import { windowLabel, localizedNumber, freshnessLabel, paceColorOf, localizedEmptyReason } from "./presentation";
import type { CardCore, RosterSecondWindow } from "./types";
import { usageWindowNumbers } from "./window-numbers";

function geminiWindowHours(kind: string): number {
  return kind === "five_hour" ? 5 : 168;
}
export function geminiCard(a: RosterAccount, color: string): CardCore {
  const g = a.gemini;
  const mine = (g?.windows ?? []).filter((w) => /^gemini/i.test(w.limit_group));
  const binding = mine.length > 0 ? mine.reduce((a2, b) => (b.used_percent > a2.used_percent ? b : a2)) : null;
  const nowMs = Date.now();
  const progressOf = (w: GeminiWindow | null): { elapsed: number | null; remaining: number | null } => {
    if (!w) return { elapsed: null, remaining: null };
    const numbers = usageWindowNumbers({
      usedPercent: w.used_percent,
      resetsAt: w.resets_at,
      windowMinutes: geminiWindowHours(w.kind) * 60,
      nowMs,
    });
    return {
      elapsed: numbers.elapsed,
      remaining: numbers.remainingHours,
    };
  };
  const bindingProgress = progressOf(binding);
  const elapsedPercent = bindingProgress.elapsed;
  const remainingHours = bindingProgress.remaining;
  const otherWindow = mine.find((w) => w !== binding) ?? null;
  const otherProgress = progressOf(otherWindow);
  const other: RosterSecondWindow | null =
    otherWindow != null
      ? {
          label: windowLabel(geminiWindowHours(otherWindow.kind) * 60),
          usedPercent: otherWindow.used_percent,
          elapsedPercent: otherProgress.elapsed,
          remainingHours: otherProgress.remaining,
          note: null,
        }
      : mine.length > 0
        ? {
            label: windowLabel(5 * 60),
            usedPercent: null,
            elapsedPercent: null,
            remainingHours: null,
            note: translate(
              "The vendor did not return the {0} window in this reading. It exists, but has no number",
              `Vendor nie wydrukował okna ${windowLabel(5 * 60)} w tym odczycie — istnieje, ale nie ma liczby`, [windowLabel(5 * 60)],
            ),
          }
        : null;
  const used = binding?.used_percent ?? null;
  const ppAhead = used != null && elapsedPercent != null ? used - elapsedPercent : null;
  const collision = (g?.fingerprint_shared_with ?? []).length > 0;
  const sp = g?.spend ?? null;
  const stale = g != null && g.age_minutes > 90;
  const note = !g
    ? translate("no /quota reading", "brak odczytu /quota")
    : !g.ok
      ? translate("no verified quota reading", "brak zweryfikowanego odczytu limitu")
      : collision
        ? translate(
            "same account as {0}",
            `to samo konto co ${g.fingerprint_shared_with.join(", ")}`, [g.fingerprint_shared_with.join(", ")],
          )
        : stale
          ? translate(
              "quota {0} h ago",
              `quota ${localizedNumber(g.age_minutes / 60, 1)} h temu`, [localizedNumber(g.age_minutes / 60, 1)],
            )
          : `quota · ${freshnessLabel(g.age_minutes)}`;
  return {
    id: a.id,
    vendor: a.vendor,
    plan: a.plan,
    color,
    basis: "inferred",
    percentMeasured: used != null,
    probe: null,
    percentFromProbe: true,
    estimatePercent: null,
    second: other,
    live: null,
    spent: used != null && used >= 100,
    usedPercent: used,
    elapsedPercent,
    ppAhead,
    paceRatio: used != null && elapsedPercent != null && elapsedPercent > 1 ? used / elapsedPercent : null,
    paceColor: paceColorOf(ppAhead),
    projectedEndPercent: null,
    remainingHours,
    resetIso: binding?.resets_at ?? null,
    tokensTotal: sp ? sp.gross : null,
    tokensFresh: sp ? sp.fresh_in + sp.out_total : null,
    allowanceTokens: null,
    usd: sp ? sp.usd : null,
    unpricedModels: sp?.unpriced_models ?? [],
    usdAt100: null,
    remainingUsd: null,
    calls: sp ? sp.generations : null,
    health: null,
    healthColor: collision ? "var(--crit)" : "var(--violet)",
    confidence: "none",
    note,
    noteLong:
      (g?.error ? `${g.error} ` : "") +
      (collision
        ? translate(
            "This profile has the same weekly reset time as {0}, and reset time is the only account identity agy exposes. It is one Google account under two handles, so its allowance is NOT additional capacity. ",
            `Ten profil ma ten sam czas resetu tygodniowego co ${g!.fingerprint_shared_with.join(", ")}, a czas resetu jest jedyną tożsamością konta, jaką agy udostępnia — to jedno konto Google pod dwoma uchwytami, więc jego zapas NIE jest dodatkową przepustowością. `, [g!.fingerprint_shared_with.join(", ")],
          )
        : "") +
      (sp
        ? translate(
            "Tokens reconstructed from the Antigravity storage protobuf ({0} generations, time resolution: conversation, not generation). Cost is API-eq from rate cards. This vendor does not provide its own price. Cache is SEPARATE from input, so gross is the sum of three components. ",
            `Tokeny odtworzone z protobufu magazynu Antigravity (${localizedNumber(sp.generations)} generacji, rozdzielczość czasu: rozmowa, nie generacja). Koszt to API-eq z rate-cards — ten vendor nie podaje własnej ceny. Cache jest ROZŁĄCZNY z inputem, więc brutto to suma trzech składników. `, [localizedNumber(sp.generations)],
          )
        : translate(
            "No conversation history is attributed to this account. ",
            "Do tego konta nie przypisano historii rozmów. ",
          )) +
      translate(
        "The vendor reports ALLOWANCE, not usage; the displayed number is already inverted.",
        "Vendor podaje ZAPAS, nie zużycie; pokazana liczba jest już odwrócona.",
      ),
    emptyReason: used == null ? (localizedEmptyReason(a.empty_reason) ?? translate("no /quota reading", "brak odczytu /quota")) : null,
    cycleLabel: binding
      ? translate(
          "window {0}",
          `okno ${windowLabel(geminiWindowHours(binding.kind) * 60)}`, [windowLabel(geminiWindowHours(binding.kind) * 60)],
        )
      : "—",
    group: "gemini",
    windowLabel: binding ? windowLabel(geminiWindowHours(binding.kind) * 60) : null,
    shadow: null,
    model: null,
    claude: null,
    gemini: g,
    grok: null,
    glm: null,
  };
}
