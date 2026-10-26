import type { RateCard } from "./pricing";
import type { LedgerRange } from "../db/codex-price-ledger";

/** Other providers, including OpenCode's OpenAI models, retain their rate dependencies. */
export function ratesWithoutAuthoritativeCodexPolicy(card: RateCard): RateCard {
  if (!card?.codex_ledger_policy) return card;
  const { codex_ledger_policy: _policy, ...rest } = card;
  return rest;
}

/** Project capacity reads complete accounting windows, including their seven-day edges. */
export function codexProjectReportLedgerRange(options: { since?: string; until?: string }): LedgerRange {
  return { ...(options.since ? { fromMs: Date.parse(options.since) - 7 * 86400000 } : {}),
    ...(options.until ? { toMs: Date.parse(options.until) + 8 * 86400000 } : {}) };
}
