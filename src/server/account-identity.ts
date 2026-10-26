import type { ObservedIdentity } from "./account-period-feed";
import { observedIdentities } from "./account-period-feed";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import type { AppContext, SubscriptionAccount } from "./app-context-types";
import { accountResolverOf, resolveSubscription, normPath } from "./account-scope";
import { normEraVendor } from "./eras";
import { archiveFolderOf } from "./event-source";

export interface IdentitySource {
  vendor: string;

  source: string;
  subscription_id: string | null;
  identity_kind: string;
  identity: string;
  declared: string | null;
  raw_source: string | null;
  ts: string;
  // One row per PC that observed the source; null for pre-journal rows.
  machine: string | null;
}

export interface IdentityWarning {
  kind: string;
  vendor: string;
  subscription_id: string | null;
  source: string;
  observed: string | null;
  declared: string | null;
  ts: string;
  hint: string;
}

export interface IdentityReport {
  sources: IdentitySource[];
  warnings: IdentityWarning[];
}

function sameIdentity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The identity behind each running observed account period (account periods model, W3). */
function currentObservedIdentities(ctx: AppContext): ObservedIdentity[] {
  try {
    return observedIdentities(ctx.sqlite, { declarations: ctx.accounts.sources, subscriptions: ctx.accounts.subscriptions, archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN });
  } catch {
    return [];
  }
}

/**
 * The subscription a source is declared for: the `accounts.json` entry whose archive folder is the
 * period's source (`<vendor>/<folder>`) at that instant; a source no declaration names falls back
 * to the account its readings name.
 */
function subscriptionForSource(ctx: AppContext, observed: ObservedIdentity): SubscriptionAccount | null {
  const owner = accountResolverOf(ctx).resolve(observed.provider, observed.source, null, observed.ts).account;
  return ctx.accounts.subscriptions.find(sub => sub.id.toLowerCase() === (owner ?? observed.account).toLowerCase()) ?? null;
}

export function activitySubscriptionAt(
  ctx: AppContext,
  provider: string,
  source: string,
  ts: string,
  fallbackSubscription: string
): string | null {
  const resolved = resolveSubscription(ctx, provider, source, ts);
  if (resolved) return resolved;
  return null;
}

export function machineForActivitySource(
  ctx: AppContext,
  provider: string,
  source: string,
  ts: string,
  fallbackSubscription: string
): string | null {
  const subscriptionId = activitySubscriptionAt(ctx, provider, source, ts, fallbackSubscription);
  if (!subscriptionId) return null;
  const normalizedProvider = normEraVendor(provider);
  const normalizedSource = normPath(source);
  const folder = archiveFolderOf(source, ARCHIVE_LOGICAL_ROOT)?.key;
  const machineSet = new Set<string>();
  for (const sub of ctx.accounts.sources) {
    if (normEraVendor(sub.vendor) !== normalizedProvider) continue;
    const declaresSource = folder ? archiveFolderOf(sub.home, ARCHIVE_LOGICAL_ROOT)?.key === folder
      : normalizedProvider === "glm" && normPath(sub.machine ?? "") === normalizedSource ? true
      : [sub.home, sub.source_home].some(candidate => candidate != null && normPath(candidate) === normalizedSource);
    if (!declaresSource) continue;
    const key = archiveFolderOf(sub.home, ARCHIVE_LOGICAL_ROOT)?.key;
    if (!key || accountResolverOf(ctx).resolve(provider, key, null, ts).account !== subscriptionId.toLowerCase()) continue;
    const machine = sub.machine?.trim();
    if (machine) machineSet.add(machine);
  }
  const machines = [...machineSet];
  return machines.length === 1 ? machines[0]! : null;
}

export function buildIdentityReport(ctx: AppContext): IdentityReport {
  const sources: IdentitySource[] = [];
  const warnings: IdentityWarning[] = [];
  for (const observed of currentObservedIdentities(ctx)) {
    const sub = subscriptionForSource(ctx, observed);
    const declared = sub?.account?.trim() || null;
    const row = { vendor: observed.provider, source: observed.home ?? observed.source, identity: observed.identity, ts: observed.ts };
    sources.push({
      vendor: row.vendor,
      source: row.source,
      subscription_id: sub?.id ?? null,
      identity_kind: observed.identity_kind,
      identity: row.identity,
      declared,
      raw_source: observed.home,
      ts: row.ts,
      machine: observed.machine,
    });
    // Declaration governs; an observation only flags the discrepancy. An
    // undeclared subscription is legal and never warns.
    if (declared && !sameIdentity(declared, row.identity)) {
      warnings.push({
        kind: "account-mismatch",
        vendor: row.vendor,
        subscription_id: sub?.id ?? null,
        source: row.source,
        observed: row.identity,
        declared,
        ts: row.ts,
        hint:
          `Źródło ${row.source} jest zalogowane na ${row.identity}, a subskrypcja ` +
          `${sub?.id ?? "?"} deklaruje ${declared} — popraw deklarację albo przeloguj konto.`,
      });
    }
  }
  return { sources, warnings };
}

/**
 * Fallback identity for a subscription that declares no vendor account: the
 * newest reading among the sources signed in to it. Declaration still
 * governs — the caller only reaches for this when there is nothing declared.
 */
export function observedVendorAccounts(ctx: AppContext): Map<string, string> {
  const best = new Map<string, { identity: string; ts: string }>();
  for (const row of currentObservedIdentities(ctx)) {
    const key = row.account.toLowerCase();
    const prev = best.get(key);
    if (!prev || row.ts > prev.ts) best.set(key, { identity: row.identity, ts: row.ts });
  }
  return new Map([...best].map(([key, row]) => [key, row.identity]));
}
