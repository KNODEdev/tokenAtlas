import type { Database } from "../db/sqlite";
import type { LedgerOwners } from "../db/window-answers";
import { loadAccountResolver, type IdentityDeclaration } from "./account-resolver";
import { normEraKey, normEraVendor } from "./eras";

/**
 * Which accounts own a provider's ledger rows of some places and instants, for the marks of stored window answers
 * (db/window-answers.ts): a session identity's account, otherwise every account whose period of the row's source
 * overlaps the instants. A place with neither cannot be told (null: every account's answers are marked).
 */
export function ledgerOwnersOf(db: Database, declarations: readonly IdentityDeclaration[]): LedgerOwners {
  return (provider, places, fromMs, untilMs) => {
    const resolver = loadAccountResolver(db, declarations), vendor = normEraVendor(provider), owners = new Set<string>();
    for (const place of places) {
      const direct = resolver.identityAccount(vendor, place.identity);
      if (direct) { owners.add(direct); continue; }
      if (!place.source) return null;
      const source = normEraKey(place.source);
      for (const account of resolver.accounts(vendor))
        if (resolver.plan(vendor, account).ranges.some(range => range.source === source && range.from < untilMs && range.until > fromMs)) owners.add(account);
    }
    return [...owners];
  };
}
