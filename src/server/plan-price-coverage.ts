import type { Database } from "../db/sqlite";
import type { RateCard } from "./pricing";
import type { PlansCatalog } from "./plans-catalog";
import { loadAccountResolver, type IdentityDeclaration } from "./account-resolver";
import { planPricingInputs, projectPlanSubscriptions, subscriptionPlanPricing } from "./project-cost-plan-pricing";
import { resolveCodexSubId } from "./capacity-equivalents";
import type { PlanPriceCoverage, PlanPriceCoverageSubject } from "../shared/plan-price-coverage";
export { planPriceGaps } from "./plan-price-gaps";
/** A billing variant (`account::business`) is a mode of one account, not an account of its own. */
const baseAccount = (id: string) => id.split("::")[0]!;

/**
 * Plan price coverage of every subscription the project report prices, read from the same stored rows and priced by
 * the same functions (`projectPlanSubscriptions`, `subscriptionPlanPricing`), without valuing any project.
 */
export function buildPlanPriceCoverage(sqlite: Database, rateCards: RateCard, opts: {
  since?: string; until?: string; plansCatalog?: PlansCatalog;
  // accounts.json rows: their identities scope the stored usage, their e-mails label the accounts.
  declarations?: readonly (IdentityDeclaration & { account?: string | null })[];
} = {}): PlanPriceCoverage {
  const resolver = loadAccountResolver(sqlite, opts.declarations);
  const subscriptions = projectPlanSubscriptions(sqlite, rateCards, { ...opts, resolver });
  const inputs = planPricingInputs(sqlite, opts.plansCatalog);
  const labels = new Map<string, string>();
  for (const row of opts.declarations ?? []) {
    const email = row.account?.trim();
    if (row.id && email && !labels.has(row.id)) labels.set(row.id, email);
  }
  const subjects = subscriptions.map(({ id, vendor, span }): PlanPriceCoverageSubject => {
    const pricing = subscriptionPlanPricing(sqlite, rateCards, inputs, { id, vendor }, span, resolver);
    const account = baseAccount(id);
    return {
      id, account, provider: vendor, label: labels.get(id) ?? labels.get(account) ?? null,
      first: span?.first ?? null, last: span?.last ?? null,
      pieces: pricing.periods, gaps: pricing.gaps, usd: pricing.paid,
      ...(vendor === "codex" && id.endsWith("::business") ? { usage_based: true as const } : {}),
      ...(id === resolveCodexSubId(null) ? { unattributed: true as const } : {}),
    };
  });
  subjects.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  return { since: opts.since ?? null, until: opts.until ?? null, subjects };
}
