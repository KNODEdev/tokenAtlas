import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { AccountResolution, AccountResolver, IdentityDeclaration } from "../server/account-resolver";
import type { SourceDeclaration } from "../server/archive-source";
import { archiveSourceKey, subscriptionRowSource } from "../server/event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { codexAccountSelector } from "../server/codex-source-account";
import { GLM_SOURCE_PROVIDERS } from "../server/subscription-accounting-adapters";
import { normalizeRebuildAccounts, type RebuildAccount } from "../shared/rebuild-accounts";
import type { UsageVendorId } from "./contracts";
import type { ReparseBounds, ReparseIdentity, ReparseSelection, ReparseSpec } from "./reparse";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const NOBODY = Symbol("owned by no account");
/** A resolved owner; time no period covers is a proven nobody, a missing source is not proof. */
const ownerOf = (resolved: AccountResolution | null): string | typeof NOBODY | null =>
  resolved?.account ?? (resolved?.basis === "gap" || resolved?.basis === "uncovered" ? NOBODY : null);

/** Fence only the selected accounts' ownership, including ranges that become owned during preparation. */
export function accountReparseOwnershipStamp(resolver: AccountResolver, vendor: UsageVendorId, selected: readonly RebuildAccount[],
  bounds?: Pick<ReparseBounds, "from" | "untilExclusive">): string {
  const provider = vendor === "opencode" ? "glm" : vendor;
  const from = bounds?.from ? Date.parse(bounds.from) : -Infinity;
  const until = bounds?.untilExclusive ? Date.parse(bounds.untilExclusive) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(until) || from >= until) throw new Error("Invalid account ownership bounds");
  return JSON.stringify(normalizeRebuildAccounts(selected).filter(item => item.vendor === vendor).map(item => {
    const plan = resolver.plan(provider, item.account);
    return [item.account, plan.identityKeys, plan.ranges.filter(r => r.from < until && r.until > from)
      .map(r => [r.source, Math.max(r.from, from), Math.min(r.until, until)])];
  }));
}

/** Resolve only ownership metadata; token quantities never pass through JavaScript. */
export function accountReparseSelection(active: Database, stage: Database, vendor: UsageVendorId,
  selected: readonly RebuildAccount[], resolver: AccountResolver, spec: ReparseSpec,
  identities: ReparseIdentity[], config: { subscriptions: readonly IdentityDeclaration[]; sources: readonly SourceDeclaration[] } = {subscriptions:[],sources:[]}): ReparseSelection & {dispose(): void} {
  const accounts = normalizeRebuildAccounts(selected).filter(item => item.vendor === vendor).map(item => item.account);
  if (!accounts.length) throw new Error(`No accounts selected for ${vendor}`);
  // A Codex row (event or limit sample) belongs to the period covering its source and instant (stage 4, W6).
  const codex = vendor === "codex" ? codexAccountSelector({ sqlite: active, resolver, accounts: config }, "events") : null;
  const mappings = new Map<string, {name: string; fields: string[]}>();
  const known = new Set<string>();

  /** The row's owner; `NOBODY` when provably no account owns it, null when that cannot be told. */
  const owner = (row: Record<string, unknown>): string | typeof NOBODY | null => {
    if (typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return null;
    // A Claude row carries its source and, when the session recorded one, its identity; the
    // account periods name the owner (stage 4, W4). Time no period covers is owned by nobody,
    // which is a proven answer; a conflicted identity or a row without a source is not.
    if (vendor === "claude") {
      if (Number(row.subscription_conflict ?? 0) !== 0 || typeof row.ts !== "string") return null;
      return ownerOf(resolver.resolve("claude", archiveSourceKey(typeof row.path === "string" ? row.path : null, ARCHIVE_LOGICAL_ROOT),
        typeof row.account_key === "string" ? row.account_key : null, row.ts));
    }
    if (codex) return typeof row.home === "string" && typeof row.ts === "string" ? ownerOf(codex.resolutionAt(row.home, row.ts)) : null;
    const provider = vendor === "opencode" ? "glm" : vendor;
    if (vendor === "opencode") {
      if (typeof row.provider !== "string" || !row.provider.trim()) return null;
      // Other OpenCode providers cannot be owned by a GLM subscription.
      if (!(GLM_SOURCE_PROVIDERS as readonly string[]).includes(row.provider.toLowerCase())) return NOBODY;
    }
    return ownerOf(resolver.resolve(provider, subscriptionRowSource(provider, row, ARCHIVE_LOGICAL_ROOT), null, row.ts));
  };

  const mapping = (database: string, table: string) => {
    const db = database === "main" ? active : stage;
    const key = `${database}:${table}`;
    let result = mappings.get(key);
    if (!result) {
      const columns = new Set((db.query(`PRAGMA table_info(${quote(table)})`).all() as {name:string}[]).map(row => row.name));
      const fields = vendor === "claude" ? ["path", "account_key", "ts", "subscription_conflict"]
        : vendor === "codex" ? ["home", "ts"]
        : vendor === "opencode" ? ["store", "ts", "provider"] : ["path", "ts"];
      const available = fields.filter(field => columns.has(field));
      if (!available.length) throw new Error(`Account ownership is unavailable in ${table}`);
      const name = `account_reparse_owners_${mappings.size}`;
      active.exec(`CREATE TEMP TABLE ${quote(name)} (${available.map(quote).join(",")}, selected INTEGER);
        CREATE INDEX ${quote(`${name}_lookup`)} ON ${quote(name)} (${available.map(quote).join(",")})`);
      result = {name, fields: available};
      mappings.set(key, result);
    }
    return result;
  };
  const predicate = (database: string, table: string, alias: string) => {
    const {name, fields} = mapping(database, table);
    return {sql: `EXISTS (SELECT 1 FROM temp.${quote(name)} o WHERE o.selected=1 AND ${fields.map(field =>
      `o.${quote(field)} IS ${quote(alias)}.${quote(field)}`).join(" AND ")})`, params: []};
  };
  return {
    predicate,
    assertKnown(database, table, alias, identity, bounds) {
      const identityKey = JSON.stringify([database, table, identity]);
      if (known.has(identityKey)) return;
      const {name, fields} = mapping(database, table);
      const where = spec.identity.map(field => `${quote(field)}=?`).join(" AND ");
      const insert = active.query(`INSERT INTO temp.${quote(name)} VALUES (${[...fields,"selected"].map(() => "?").join(",")})`);
      // Read only metadata for this source identity, including closure identities discovered later.
      using metadata=active.prepare(`SELECT DISTINCT ${fields.map(quote).join(",")} FROM ${quote(database)}.${quote(table)} WHERE ${where}`);
      for (const row of metadata.iterate(...spec.identity.map(field => identity[field]!)) as Iterable<Record<string, SQLQueryBindings>>) {
        const account = owner(row);
        // Dated metadata outside a bounded request does not select a row.
        const time=typeof row.ts==="string" ? Date.parse(row.ts) : NaN;
        const outside=bounds && Number.isFinite(time) && (bounds.from && time<Date.parse(bounds.from)
          || bounds.untilExclusive && time>=Date.parse(bounds.untilExclusive));
        if (account === null && !outside) throw new Error(`Account ownership cannot be proven in ${table} for ${JSON.stringify(identity)}; accepted facts were kept`);
        insert.run(...fields.map(field => row[field] ?? null), typeof account === "string" && accounts.includes(account) ? 1 : 0);
      }
      known.add(identityKey);
    },
    dispose() { for (const {name} of mappings.values()) active.exec(`DROP TABLE IF EXISTS temp.${quote(name)}`); },
  };
}
