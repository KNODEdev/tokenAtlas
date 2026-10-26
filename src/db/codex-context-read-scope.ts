import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Database } from "./sqlite";
import type { LedgerRange, LedgerStoredGroup } from "./codex-price-ledger";
import type { LedgerReadGroup, LedgerTierPolicy } from "./codex-price-ledger-read";
import type { Rational } from "./price-ledger-exact";

/** Request-local alternative presentation. Never changes a published ledger row or a shared read cache. */
export interface ContextReadScope {
  db: Database;
  ranges: WeakMap<LedgerStoredGroup, LedgerRange>;
  eventIds: WeakMap<LedgerStoredGroup, number>;
  members: WeakMap<LedgerStoredGroup, readonly LedgerStoredGroup[]>;
  capturing?: boolean;
  derived: Map<string, readonly LedgerReadGroup<readonly import("./codex-price-ledger-read").LedgerVariant[]>[]>;
  capturedGroups: number;
  policies: WeakMap<LedgerTierPolicy, number>;
  nextPolicy: number;
  originals: WeakMap<object, Rational | null>;
  bucketParts?: WeakMap<LedgerStoredGroup, import("./codex-context-details").ContextBucketParts>;
  modelWindow?(account: string, counter: string, id: string, preparing?: boolean): import("../server/codex-context-model-producer").ContextModelWindow | null;
  apply(group: LedgerReadGroup<readonly import("./codex-price-ledger-read").LedgerVariant[]>, policy: LedgerTierPolicy): void;
}
const scopes = new AsyncLocalStorage<ContextReadScope>();
export const runContextRead = <T>(scope: ContextReadScope, read: () => T): T => scopes.run(scope, read);
const contextReadSession = (db: Database) => { const scope = scopes.getStore(); return scope?.db === db ? scope : undefined; };
export const inContextRead = (db: Database) => contextReadSession(db) !== undefined;
export const contextReadScope = (db: Database) => { const scope = contextReadSession(db); return scope?.capturing ? undefined : scope; };
export function captureContextRead<T>(scope: ContextReadScope, read: () => T): T {
  scope.capturing = true;
  try { return runContextRead(scope, read); } finally { scope.capturing = false; }
}
/** Keep capture active across the history builder's cancellation checkpoints. */
export async function captureContextReadAsync<T>(scope: ContextReadScope, read: () => Promise<T>): Promise<T> {
  scope.capturing = true;
  try { return await runContextRead(scope, read); } finally { scope.capturing = false; }
}
/** Reuse immutable derivations within the paired read, bounded to 20k groups; no cross-request or durable cache. */
export function contextDerivedGroups<T extends LedgerReadGroup<readonly import("./codex-price-ledger-read").LedgerVariant[]>>(
  db: Database, policy: LedgerTierPolicy, rows: readonly LedgerStoredGroup[], variants: readonly string[] | undefined, read: () => T[]): T[] {
  const scope = contextReadSession(db);
  if (!scope || !rows.length || rows.length > 20_000 || !scope.capturing && !scope.derived.size) return read();
  let policyId = scope.policies.get(policy);
  if (policyId === undefined) { policyId = scope.nextPolicy++; scope.policies.set(policy, policyId); }
  const hash = createHash("sha256").update(JSON.stringify([policyId, variants ?? null]));
  // Compiled read policies are immutable; distinct policy objects can never share a derivation.
  for (const row of rows) hash.update(JSON.stringify(row));
  const key = hash.digest("hex"), cached = scope.derived.get(key);
  if (!scope.capturing && cached) return cached.map((group, index) => projectContextGroup(db,
    { ...group, stored: rows[index]!, variants: { ...group.variants } } as T, policy));
  const result = read();
  if (scope.capturing && !cached && scope.capturedGroups + rows.length <= 20_000) {
    scope.derived.set(key, result); scope.capturedGroups += rows.length;
  }
  return result;
}
export function markContextRange<T extends readonly LedgerStoredGroup[]>(db: Database, rows: T, range: LedgerRange): T {
  const scope = contextReadScope(db);
  if (scope) for (const row of rows) scope.ranges.set(row, range);
  return rows;
}
export function projectContextGroup<T extends LedgerReadGroup<readonly import("./codex-price-ledger-read").LedgerVariant[]>>(
  db: Database, group: T, policy: LedgerTierPolicy): T {
  const scope = contextReadScope(db);
  if (scope) {
    if (group.variants.api_standard) scope.originals.set(group, group.variants.api_standard.value);
    scope.apply(group, policy);
  }
  return group;
}
export function originalContextApi(db: Database, group: object, fallback: Rational | null): Rational | null {
  const originals = contextReadScope(db)?.originals;
  return originals?.has(group) ? originals.get(group)! : fallback;
}
