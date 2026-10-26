import { normEraKey, normEraVendor } from "./eras";

/** The part of an accounts.json entry that defines a source: which local profile is kept in which archive folder. */
export interface SourceDeclaration { vendor?: string; machine?: string; login?: string; home?: string | null; source_home?: string | null }
export interface LocalProfile { machine: string; login: string; home: string }

/**
 * The archive source (`codex/EXAMPLE-MAIN-sample_a`) that holds the sessions of a local profile —
 * the subject of an account period, and the only source identity an event knows.
 *
 * Mirrors the rule the copy step applies (`profileMirrorTargets`): a declared profile goes where
 * its declaration says, an undeclared one to the conventional folder. Dates on a declaration are
 * ignored on purpose: they describe accounts, and the folder of a profile does not move with them.
 * `declarations` carry expanded paths. Null when the profile has no archive folder or two
 * declarations disagree about it.
 *
 * Claude's conventional folder has no login in its name, so it belongs to one profile per
 * computer: the `.claude` of `defaultLogin`, the Windows account the application runs under.
 *
 * An Antigravity pool worker (`pool:<id>`) names no directory: it runs under the Windows account
 * `profile.login`, whose `.gemini` the copy step keeps like any other profile of that account.
 */
export function archiveSourceOf(
  vendor: string, profile: LocalProfile, declarations: readonly SourceDeclaration[], archiveRoot: string, defaultLogin: string,
): string | null {
  const provider = normEraVendor(vendor), root = normEraKey(archiveRoot);
  const pooled = provider === "gemini" && /^pool:[^/]+$/.test(normEraKey(profile.home));
  // The pool reading knows the account, not the users' folder, so a declaration matches by its tail.
  const home = pooled ? `/${normEraKey(profile.login)}/.gemini` : normEraKey(profile.home);
  const declared = new Set<string>();
  for (const d of declarations) {
    if (normEraVendor(d.vendor) !== provider || !d.home || !d.source_home) continue;
    if (pooled ? !normEraKey(d.source_home).endsWith(home) : normEraKey(d.source_home) !== home) continue;
    if (d.machine && normEraKey(d.machine) !== normEraKey(profile.machine)) continue;
    const folder = normEraKey(d.home);
    if (!folder.startsWith(root + "/")) continue;
    const parts = folder.slice(root.length + 1).split("/");
    if (parts.length >= 2) declared.add(`${parts[0]}/${parts[1]}`);
  }
  if (declared.size) return declared.size === 1 ? [...declared][0]! : null;
  if (home.split("/").at(-1) !== `.${provider}`) return null;
  if (provider !== "claude") return `${provider}/${profile.machine}-${profile.login}`.toLowerCase();
  return normEraKey(profile.login) === normEraKey(defaultLogin) ? `claude/${profile.machine}`.toLowerCase() : null;
}
