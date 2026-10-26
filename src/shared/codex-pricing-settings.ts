import type { CodexAccountingRule } from "./codex-accounting";

export interface CodexPricingSettings {
  revision: string;
  rules: CodexAccountingRule[];
  /** Whether API equivalents apply the rules' long-context rates. */
  long_context_premium: boolean;
}
/** Exactly one of `rule`, `remove` or `long_context_premium` per save. */
export interface CodexPricingEdit {
  revision: string;
  rule?: CodexAccountingRule;
  replace_id?: string;
  remove?: string;
  long_context_premium?: boolean;
}
