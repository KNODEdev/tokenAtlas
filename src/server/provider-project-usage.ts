import { subscriptionAccountDiscovery } from "./subscription-account-discovery";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import type { Database } from "bun:sqlite";
import type { RegisterDayRow } from "../db/usage-price-read-account";
import { GLM_PROVENANCE_RULE, PROVIDER_MODEL_RATE_RULE, GROK_PROVENANCE_RULE, subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import type { EraIndex } from "./eras";
import type { RateCard } from "./pricing";
import { ledgerDayBounds } from "./ledger-sums";

/**
 * Grok's and GLM's side of the project and repository reports: which verified accounts have plan traffic on which days, what
 * no account owns, and the shapes of that evidence and of the conflict exclusions. Their traffic and money are stored day
 * sums (stored-project-usage.ts, stored-history-usage.ts); nothing here prices, deduplicates or walks calls.
 */
export const PROVIDER_PROJECT_USAGE_ALGORITHM = 2;
export const PROVIDER_PROJECT_USAGE_CONTRACT = [
  PROVIDER_PROJECT_USAGE_ALGORITHM,
  GROK_PROVENANCE_RULE,
  GLM_PROVENANCE_RULE,
  PROVIDER_MODEL_RATE_RULE,
] as const;

export type ProjectFactProvider = "grok" | "glm";
export type ProviderProjectEvidenceReason = "unmapped_account" | "ambiguous_account" | "source_without_identity";
export interface ProviderProjectEvidence {
  reason: ProviderProjectEvidenceReason;
  tokens: number;
  calls: number;
}
export interface ProviderProjectConflict {
  account: string;
  identities: number;
}

/** The provider's fact table and whether it exists with a timestamp: without one nothing can be dated. */
function factSource(sqlite: Database, provider: ProjectFactProvider): { table: string; present: boolean } {
  const table = subscriptionAccountingAdapter(provider).table;
  return { table, present: (sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === "ts") };
}
export interface ProviderDayDiscovery {
  accountDays: Map<string, Set<string>>;
  evidence: Map<ProviderProjectEvidenceReason, { tokens: number; calls: number }>;
  /** The register day rows of the range (`readRegisterDays`), so a report reads them once. */
  rows: RegisterDayRow[];
}

/** Which verified accounts have plan traffic on which days, and what no account owns: from the usage ledger, never the fact table. */
export function providerSourceDiscovery(sqlite: Database, rateCards: RateCard,
  provider: ProjectFactProvider, options: { since: string; until: string; eras?: EraIndex; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[] }): ProviderDayDiscovery {
  if (!factSource(sqlite, provider).present) return { accountDays: new Map(), evidence: new Map(), rows: [] };
  const resolved = subscriptionAccountDiscovery(sqlite, provider, options.resolver ?? loadAccountResolver(sqlite, options.declarations), options, rateCards);
  return { accountDays: resolved.accountDays, evidence: resolved.evidence, rows: resolved.rows };
}

/** The first and last UTC day of the provider's plan traffic, from the usage ledger's day sums. */
export function providerSourceDayBounds(sqlite: Database, provider: ProjectFactProvider): { first: string | null; last: string | null } {
  if (!factSource(sqlite, provider).present) return { first: null, last: null };
  return provider === "glm" ? ledgerDayBounds(sqlite, "opencode", "plan") : ledgerDayBounds(sqlite, "grok");
}
