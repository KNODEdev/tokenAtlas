import type { CodexTokenRates, TimelineMarker } from "./codex-accounting";

export interface CodexPriceChange {
  marker: TimelineMarker;
  includedUsage: "declared_change" | "unverified";
  models: Array<{
    name: string;
    apiBefore: CodexTokenRates;
    apiAfter: CodexTokenRates;
    creditsBefore: CodexTokenRates | null;
    creditsAfter: CodexTokenRates;
  }>;
  sources: string[];
}

const rates = (input: number, cached: number, output: number): CodexTokenRates => ({ in_uncached: input, in_cache_read: cached, out_total: output });

// Evidence for timeline annotations, not a replacement for the dated billing rules.
export const CODEX_PRICE_CHANGES: CodexPriceChange[] = [
  {
    marker: { id: "price:gpt-5.6-luna-terra-20260730", day: "2026-07-30", label: "Luna −80%, Terra −20% · API, credits, included usage", color: "warn", visible: true,
      note: "OpenAI wiąże obniżkę stawek z aktualizacją limitów użycia. Przy niezmienionym budżecie i proporcjonalnym naliczaniu: Luna 5×, Terra 1,25× więcej tej samej pracy; wartość API przy nowych cenach pozostaje taka sama. To warunkowe przeliczenie, nie potwierdzona zmiana nominalnego budżetu Pro. https://learn.chatgpt.com/docs/whats-new#use-gpt-56-terra-and-luna-at-lower-rates" },
    includedUsage: "declared_change",
    models: [
      { name: "GPT-5.6 Luna", apiBefore: rates(1, .1, 6), apiAfter: rates(.2, .02, 1.2), creditsBefore: rates(25, 2.5, 150), creditsAfter: rates(5, .5, 30) },
      { name: "GPT-5.6 Terra", apiBefore: rates(2.5, .25, 15), apiAfter: rates(2, .2, 12), creditsBefore: rates(62.5, 6.25, 375), creditsAfter: rates(50, 5, 300) },
    ],
    sources: ["https://learn.chatgpt.com/docs/whats-new#use-gpt-56-terra-and-luna-at-lower-rates", "https://developers.openai.com/api/docs/changelog#july-2026", "https://learn.chatgpt.com/docs/pricing#token-rates"],
  },
  {
    marker: { id: "price:gpt-5.6-sol-api-20260821", day: "2026-08-21", label: "Sol promotion · API changed; subscription effect unverified", color: "warn", visible: true,
      note: "Promocja API: input −20%, output −33⅓%, co najmniej do 21 listopada, bez potwierdzonego końca. Przypis o promocji jest też pod tabelą kredytów 100/10/500; nie dowodzi jednak wcześniejszej stawki ani daty jej zmiany. Nie można oznaczać zmiany jako wyłącznie API ani zakładać stałego budżetu Pro. https://learn.chatgpt.com/docs/pricing#token-rates ; https://developers.openai.com/api/docs/changelog#august-2026" },
    includedUsage: "unverified",
    models: [{ name: "GPT-5.6 Sol", apiBefore: rates(5, .5, 30), apiAfter: rates(4, .4, 20), creditsBefore: null, creditsAfter: rates(100, 10, 500) }],
    sources: ["https://developers.openai.com/api/docs/changelog#august-2026", "https://developers.openai.com/api/docs/models/gpt-5.6-sol", "https://learn.chatgpt.com/docs/pricing#token-rates"],
  },
];

export function priceChangeFor(marker: TimelineMarker): CodexPriceChange | undefined {
  // A manually moved point must not certify an invented effective date.
  return CODEX_PRICE_CHANGES.find(change => change.marker.id === marker.id && change.marker.day === marker.day);
}

/** Uniform token-price reductions permit one inverse work multiplier; mixed rates do not. */
export function uniformPriceRatio(before: CodexTokenRates, after: CodexTokenRates): number | null {
  const keys = ["in_uncached", "in_cache_read", "out_total"] as const;
  if (keys.some(key => !Number.isFinite(before[key]) || before[key] <= 0 || !Number.isFinite(after[key]) || after[key] <= 0)) return null;
  const ratios = keys.map(key => after[key] / before[key]);
  return ratios.every(ratio => Math.abs(ratio - ratios[0]!) < 1e-10) ? ratios[0]! : null;
}
