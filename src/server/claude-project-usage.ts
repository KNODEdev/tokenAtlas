import { subscriptionAccountDiscovery } from "./subscription-account-discovery";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
/**
 * Claude's side of the project and repository reports: which verified accounts have traffic on which days, what the source
 * shows that no account owns, and the shapes of the evidence and conflict exclusions those reports publish. Their traffic
 * and money are stored day sums (stored-project-usage.ts, stored-history-usage.ts); nothing here prices, deduplicates or
 * walks calls.
 *
 * Calls whose copies contradict each other are accepted by nobody: their tokens and price are unknown rather than zero. They
 * are published as a count of excluded identities per account and range and are added to no token, call or money sum.
 */
import type { Database } from "bun:sqlite";
import type { RegisterDayRow } from "../db/usage-price-read-account";
import type { RateCard } from "./pricing";
import { ledgerDayBounds } from "./ledger-sums";

/**
 * Bumped when the meaning of the published conflict exclusions changes. It versions every report that composes them, but
 * deliberately *not* the stored day sums: an excluded identity was never part of them.
 */
export const CLAUDE_CONFLICT_RULE = "claude-conflicts-v1";

/**
 * Observed rows that cannot be assigned to a verified account. They are evidence,
 * not a deduplicated account: copies are counted as they appear in the source.
 */
export type ClaudeProjectEvidenceReason = "unverified_account" | "source_without_identity";
export interface ClaudeProjectEvidence {
  reason: ClaudeProjectEvidenceReason;
  tokens: number;
  calls: number;
}

/**
 * Canonical calls the shared fact reader refuses to accept because their live copies
 * contradict each other on timestamp, model, mode or counters. Their true token count and
 * their true price are UNKNOWN, so they are in no token, call, dollar or coverage sum: this
 * counter exists so the exclusion is visible instead of silent.
 *
 * Scope is one verified ACCOUNT and the whole selected UTC range, never one project: the
 * copies can disagree about the subject, so which project lost the traffic is unknown too.
 * `identities` counts DISTINCT conflicting calls once for the whole range - it is not a sum
 * of per-day counts and it is not a number of accepted calls. An identity counts when any of
 * its copies falls in the range; a copy dated outside the selection still invalidates it,
 * exactly as it does for the accepted sums. Identical copies are duplicates, not conflicts.
 * No event id and no payload is published here.
 */
export interface ClaudeConflictingIdentities {
  account: string;
  identities: number;
}

/** Whether the Claude fact table exists with a timestamp: without one nothing can be bounded, selected or dated. */
function claudeSourcePresent(sqlite: Database): boolean {
  return (sqlite.query("PRAGMA table_info(claude_events)").all() as Array<{ name: string }>).some(row => row.name === "ts");
}

/** Verified account days plus the traffic no account owns, as observed in the source, and the day rows they come from. */
export interface ClaudeDayDiscovery {
  accountDays: Map<string, Set<string>>;
  unverified: { tokens: number; calls: number };
  /** The register day rows of the range (`readRegisterDays`), so a report reads them once. */
  rows: RegisterDayRow[];
}

/**
 * The one source-day discovery every Claude report shares: which verified accounts have traffic on which canonical UTC days,
 * and what the source shows that no account owns, from the usage ledger (`subscriptionAccountDiscovery`), never from the
 * fact table.
 */
export function claudeSourceDiscovery(sqlite: Database, rateCards: RateCard,
  options: { since: string; until: string; resolver?: AccountResolver; declarations?: readonly IdentityDeclaration[] }): ClaudeDayDiscovery {
  if (!claudeSourcePresent(sqlite)) return { accountDays: new Map(), unverified: { tokens: 0, calls: 0 }, rows: [] };
  const resolved = subscriptionAccountDiscovery(sqlite, "claude", options.resolver ?? loadAccountResolver(sqlite, options.declarations), options, rateCards);
  return { accountDays: resolved.accountDays, unverified: resolved.unverified, rows: resolved.rows };
}

/**
 * The first and last canonical UTC day the source still carries, from the usage ledger's day sums:
 * deleted rows stop counting and rows no verified account owns are coverage too.
 */
export function claudeSourceDayBounds(sqlite: Database): { first: string | null; last: string | null } {
  return claudeSourcePresent(sqlite) ? ledgerDayBounds(sqlite, "claude") : { first: null, last: null };
}
