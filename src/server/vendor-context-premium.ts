import type { RateCard } from "./pricing";

/**
 * Names the per-vendor long-context premium contract in valuation digests: absent means off, so a card
 * without the flag values long requests at their base rates (owner decision 2026-10-20). Codex keeps its own
 * flag in `codex_accounting`.
 */
export const VENDOR_CONTEXT_PREMIUM_RULE = "vendor-context-premium-default-off-v1";

/** Whether a vendor's API values apply its models' long-context rates, as its paid API bills them. */
export function vendorContextPremium(card: RateCard, vendor: string): boolean {
  return card.vendors[vendor]?.long_context_premium === true;
}

/** Whether any model of the vendor (or one of its variants) has a long-context tier. */
export function vendorHasContextTier(card: RateCard, vendor: string): boolean {
  return Object.values(card.vendors[vendor]?.models ?? {}).some(model => !!model
    && (!!model.long_context || !!model.after?.long_context || !!model.fast?.long_context));
}
