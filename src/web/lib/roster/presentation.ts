import type { RosterAccount } from "../api";
import { translate, getLocale } from "../i18n";
import { vendorShade } from "../model-colors";
import type { RosterCard } from "./types";

export function localizedEmptyReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  // The server names the missing series; the card only needs to say that no reading exists yet.
  if (/^no samples for window=\d+ limit_id=\S+ in the selected range$/.test(reason))
    return translate("no limit reading in this window yet", "brak odczytu limitu w tym oknie");
  if (reason === "brak odczytu tygodniowego w claude-gauge.json") return translate("No Claude limit reading yet", "Brak odczytu limitu Claude");
  const known: Record<string, string> = {
    "brak odczytu /quota — pula Gemini nie jest dostępna na tej maszynie": "No /quota reading: the Gemini pool is unavailable on this machine",
    "brak odczytu /quota — poller jeszcze nie przemiótł puli": "No /quota reading: the poller has not checked the pool yet",
    "brak próbek gauge w indeksie": "No gauge samples in the index",
    "brak tur i odczytu Billing w tym oknie": "No turns or Billing reading in this window",
  };
  return known[reason] ? translate(known[reason]!, reason) : reason;
}
export function subscriptionName(card: Pick<RosterCard, "id" | "group" | "vendorAccount">): string {
  return card.vendorAccount || card.id;
}
/** Labels share the rail's roster; IDs remain the keys for facts and prices. */
export function subscriptionNameLookup(cards: Pick<RosterCard, "id" | "group" | "vendorAccount">[]): (id: string) => string {
  const names = new Map(cards.map(card => [card.id.toLowerCase(), subscriptionName(card)]));
  return id => names.get(id.toLowerCase()) ?? id;
}
const PROVIDER_COLORS: Readonly<Record<string, string>> = {
  anthropic: "var(--claude)",
  claude: "var(--claude)",
  codex: "var(--codex)",
  openai: "var(--codex)",
  gemini: "var(--gemini)",
  grok: "var(--grok)",
  glm: "var(--glm)",
  opencode: "var(--glm)",
  zai: "var(--glm)",
  "z.ai": "var(--glm)",
};
export function providerColor(vendor: string | null | undefined): string {
  return vendor ? PROVIDER_COLORS[vendor.toLowerCase()] ?? "var(--accent)" : "var(--accent)";
}
export function vendorColor(a: RosterAccount, codexSeen: number): string {
  if (a.vendor === "claude" || a.vendor === "anthropic") return providerColor(a.vendor);
  return vendorShade("var(--codex)", codexSeen);
}
export function paceColorOf(ppAhead: number | null): string {
  if (ppAhead == null) return "var(--muted)";
  if (ppAhead > 8) return "var(--warn)";
  return "var(--text)";
}
export function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
export function freshnessLabel(minutes: number): string {
  if (minutes < 1) return translate("just now", "przed chwilą");
  if (minutes < 60) {
    const value = localizedNumber(minutes, 0);
    return translate("{0} min ago", `${value} min temu`, [value]);
  }
  const value = localizedNumber(minutes / 60, 1);
  return translate("{0} h ago", `${value} h temu`, [value]);
}
export function subscriptionCountLabel(count: number): string {
  const value = localizedNumber(count);
  const mod10 = count % 10;
  const mod100 = count % 100;
  const polishNoun =
    count === 1
      ? "subskrypcja"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "subskrypcje"
        : "subskrypcji";
  return translate(count === 1 ? "{0} subscription" : "{0} subscriptions", `${value} ${polishNoun}`, [value]);
}
export function gaugeNote(ageHours: number | null): { short: string; long: string } {
  if (ageHours == null)
    return {
      short: translate("no samples", "brak próbek"),
      long: translate("The account has no gauge sample in the index yet.", "Konto nie ma jeszcze żadnej próbki gauge w indeksie."),
    };
  if (ageHours < 3)
    return {
      short: translate("live gauge", "gauge na żywo"),
      long: translate(
        "Last gauge sample {0} min ago.",
        `Ostatnia próbka gauge sprzed ${localizedNumber(ageHours * 60)} min.`, [localizedNumber(ageHours * 60)],
      ),
    };
  if (ageHours < 24)
    return {
      short: translate("gauge {0} h ago", `gauge ${localizedNumber(ageHours)} h temu`, [localizedNumber(ageHours)]),
      long: translate(
        "Last gauge sample was {0} h ago. The percentage is from that moment, not now.",
        `Ostatnia próbka gauge sprzed ${localizedNumber(ageHours, 1)} h — procent jest z tego momentu, nie z teraz.`, [localizedNumber(ageHours, 1)],
      ),
    };
  return {
    short: translate(
      "gauge {0} days ago",
      `gauge ${localizedNumber(ageHours / 24)} dni temu`, [localizedNumber(ageHours / 24)],
    ),
    long: translate(
      "Last gauge sample was {0} days ago. Synchronize the index before treating this percentage as current.",
      `Ostatnia próbka gauge sprzed ${localizedNumber(ageHours / 24, 1)} dni. Zsynchronizuj indeks, zanim uznasz ten procent za aktualny.`, [localizedNumber(ageHours / 24, 1)],
    ),
  };
}
export function windowLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${localizedNumber(minutes / (24 * 60))}d`;
  if (minutes % 60 === 0) return `${localizedNumber(minutes / 60)}h`;
  return `${localizedNumber(minutes)}m`;
}
