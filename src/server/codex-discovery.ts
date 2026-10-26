import type { Database } from "bun:sqlite";
import { codexIdentityEvidence, discoveredCodexId, type CodexIdentityEvidence, type CodexProfile } from "../providers/codex-identity";

export interface DiscoveredCodexAccount {
  id: string;
  email: string | null;
  key: string;
  current: boolean;
  profiles: CodexIdentityEvidence[];
}
export interface CodexDiscovery {
  profiles: CodexProfile[];
  accounts: DiscoveredCodexAccount[];
}

/** Probe metadata travels through the existing gauge journal, including between machines. */
export function rememberedCodexAccounts(sqlite: Database): CodexIdentityEvidence[] {
  const rows = sqlite.query(`SELECT (
    SELECT extra FROM probe_windows p WHERE p.provider='codex' AND p.subject=s.subject
      AND json_extract(p.extra, '$.codex_account') IS NOT NULL ORDER BY ts DESC LIMIT 1
  ) AS extra FROM (SELECT DISTINCT subject FROM probe_windows WHERE provider='codex') s`).all() as { extra: string | null }[];
  return rows.flatMap(row => { const identity = codexIdentityEvidence(row.extra); return identity ? [identity] : []; });
}

export interface CodexDeclaration { id: string; vendor?: string; account?: string | null }
/** Declared Codex sign-ins. `id::variant` is a billing mode of one account (business credits), never a login of its own. */
function loginDeclarations(declarations: readonly CodexDeclaration[]): CodexDeclaration[] {
  return declarations.filter(d => (d.vendor ?? "codex") === "codex" && !d.id.includes("::"));
}

/**
 * Minted ids (`chatgpt-…`) that name a declared subscription's ChatGPT account: the latest readings of
 * both carry the same identity key. Such an id was stamped while the login could not be matched to its
 * declaration, so its readings belong to the declared subscription. Keys are lower case.
 */
export function codexIdentityAliases(remembered: readonly CodexIdentityEvidence[],
  declarations: readonly CodexDeclaration[]): Map<string, string> {
  const declared = new Set(loginDeclarations(declarations).map(d => d.id.toLowerCase()));
  const owners = new Map<string, Set<string>>();
  for (const e of remembered) if (declared.has(e.subscription.toLowerCase()))
    owners.set(e.key, (owners.get(e.key) ?? new Set()).add(e.subscription));
  const out = new Map<string, string>();
  for (const e of remembered) {
    const owner = owners.get(e.key);
    // Two declarations on one login are the owner's to settle; neither absorbs the minted id.
    if (!declared.has(e.subscription.toLowerCase()) && owner?.size === 1) out.set(e.subscription.toLowerCase(), [...owner][0]!);
  }
  return out;
}

export function resolveCodexDiscovery(profiles: CodexProfile[], declarations: CodexDeclaration[],
  remembered: CodexIdentityEvidence[] = [], localMachine?: string): CodexDiscovery {
  const byKey = new Map<string, DiscoveredCodexAccount>();
  const logins = loginDeclarations(declarations);
  const declared = new Set(logins.map(d => d.id.toLowerCase()));
  for (const prior of remembered) {
    // One login remembered under a declared and a minted id resolves to the declared one, whatever the row order.
    const held = byKey.get(prior.key);
    if (held && declared.has(held.id.toLowerCase()) && !declared.has(prior.subscription.toLowerCase())) continue;
    byKey.set(prior.key, { id: prior.subscription, email: prior.email, key: prior.key,
      current: prior.machine !== localMachine, profiles: [prior] });
  }
  const keysForEmail = new Map<string, Set<string>>();
  for (const identity of [...remembered, ...profiles.flatMap(p => p.identity ? [p.identity] : [])]) {
    if (!identity.email) continue;
    const keys = keysForEmail.get(identity.email) ?? new Set<string>();
    keys.add(identity.key); keysForEmail.set(identity.email, keys);
  }
  for (const profile of profiles) {
    const identity = profile.identity;
    if (!identity) continue;
    let account = byKey.get(identity.key);
    if (!account) {
      const ids = new Set(logins.filter(d => d.account &&
        (d.account.toLowerCase() === identity.account_id?.toLowerCase() ||
          (d.account.toLowerCase() === identity.email && keysForEmail.get(identity.email)?.size === 1))).map(d => d.id));
      const id = ids.size === 1 ? [...ids][0]! : discoveredCodexId(identity);
      account = { id, email: identity.email, key: identity.key, current: true, profiles: [] };
      byKey.set(identity.key, account);
    }
    account.current = true;
    account.email = identity.email ?? account.email;
    account.profiles = account.profiles.filter(p => !(p.machine === profile.machine && p.home === profile.home));
    account.profiles.push({ ...identity, subscription: account.id, home: profile.home, login: profile.login, machine: profile.machine });
  }
  return { profiles, accounts: [...byKey.values()] };
}
