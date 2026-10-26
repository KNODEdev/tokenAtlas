import type { Database } from "bun:sqlite";
import { analysisHash } from "../db/analysis";
import type { CodexAccountOptions, CodexAccountSelector, CodexAccountSql } from "./codex-source-account";

/** This is a separate billing pool, not a claim about an unknown workspace identity. */
export function codexEventOwner(owner: string | null, event: { billing_mode?: string | null }): string | null {
  return event.billing_mode === "business_credits" ? `${owner || "codex-unassigned"}::business` : owner;
}

const hasBillingMode = (sqlite: Database): boolean =>
  (sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(c => c.name === "billing_mode");
const finish = (sql: string, params: CodexAccountSql["params"]): CodexAccountSql => ({ sql, params, stamp: analysisHash([sql, params]) });

/**
 * `codexEventOwner` in SQL for an `events` row: the account its period names (`selector` built on
 * `events`), or that account's business credit pool; NULL for an ordinary row no period owns.
 */
export function codexEventOwnerOf(sqlite: Database, selector: CodexAccountSelector, options: CodexAccountOptions = {}): CodexAccountSql {
  const account = selector.account(options);
  if (!hasBillingMode(sqlite)) return account;
  const mode = options.alias ? `${options.alias}.billing_mode` : "billing_mode";
  return finish(`CASE WHEN ${mode} = 'business_credits' THEN COALESCE(${account.sql}, 'codex-unassigned') || '::business' ELSE ${account.sql} END`,
    [...account.params, ...account.params]);
}

/** Predicate selecting the `events` rows `codexEventOwnerOf` names `owner`: a business pool never counts for its account. */
export function codexEventOwnedBy(sqlite: Database, selector: CodexAccountSelector, owner: string, options: CodexAccountOptions = {}): CodexAccountSql {
  const wanted = owner.toLowerCase();
  if (!hasBillingMode(sqlite)) return selector.ownedBy(wanted, options);
  const mode = options.alias ? `${options.alias}.billing_mode` : "billing_mode";
  if (wanted.endsWith("::business")) {
    const pool = wanted.slice(0, -"::business".length);
    const account = pool === "codex-unassigned" ? null : selector.ownedBy(pool, options);
    return account ? finish(`(${mode} = 'business_credits' AND ${account.sql})`, account.params)
      : finish(`(${mode} = 'business_credits' AND ${selector.account(options).sql} IS NULL)`, selector.account(options).params);
  }
  const own = selector.ownedBy(wanted, options);
  return finish(`(${own.sql} AND ${mode} IS NOT 'business_credits')`, own.params);
}
