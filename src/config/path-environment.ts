import os from "node:os";
import path from "node:path";
import { readLocalArchiveSelection } from "./archive-locator";
import {
  ExternalArchivePathError,
  physicalArchivePath,
  readCanonicalArchiveRoot,
} from "./archive-paths";

const ARCHIVE_SUFFIX = ["_Hub", "02_PRODUCTS", "tokenUsage"] as const;

/** Explicit process configuration wins; the legacy guess is used only without a durable local choice. */
export function resolveArchiveRootFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.TOKENATLAS_ARCHIVE?.trim();
  if (explicit) return path.resolve(explicit);
  const selected = readLocalArchiveSelection(env);
  if (selected) return selected.root;
  const oneDrive = (env.OneDrive || env.ONEDRIVE)?.trim();
  if (oneDrive) return path.join(oneDrive, ...ARCHIVE_SUFFIX);
  return path.join(os.homedir(), "OneDrive", ...ARCHIVE_SUFFIX);
}

export interface EnvironmentPathValues {
  archive: string;
  home: string;
  machine: string;
  login: string;
}

/** Apply the path substitutions shared by cached runtime paths and activation checks. */
export function expandEnvironmentPath(raw: string, values: EnvironmentPathValues): string {
  const profile = `${values.machine}-${values.login}`;
  const substituted = raw
    .replace(/\$\{ARCHIVE\}/g, values.archive)
    .replace(/\$\{USERPROFILE\}|\$\{HOME\}/g, values.home)
    .replace(/\$\{MACHINE\}/g, values.machine)
    .replace(/\$\{PROFILE\}/g, profile)
    .replace(/\$\{LOGIN\}/g, values.login);
  const tilde = substituted.startsWith("~")
    ? path.join(values.home, substituted.slice(1))
    : substituted;
  return path.normalize(tilde);
}

function rebaseConfiguredPath(binding: ReturnType<typeof readCanonicalArchiveRoot>, candidate: string): string {
  if (!binding) return candidate;
  try { return physicalArchivePath(binding, candidate); }
  catch (error) {
    if (error instanceof ExternalArchivePathError) return candidate;
    throw error;
  }
}

/** Resolve one supplied declaration against a selected physical archive without module globals. */
export function resolveOverridePhysicalPathFromEnv(
  raw: string,
  env: Record<string, string | undefined> = process.env,
  physicalArchive: string = resolveArchiveRootFromEnv(env),
): string {
  const physical = path.resolve(physicalArchive);
  const binding = readCanonicalArchiveRoot(physical);
  const expanded = expandEnvironmentPath(raw, {
    archive: binding?.originalLogicalRoot ?? physical,
    home: env.USERPROFILE || os.homedir(),
    machine: env.TOKENATLAS_MACHINE?.trim() || env.COMPUTERNAME?.trim() || os.hostname(),
    login: env.TOKENATLAS_LOGIN?.trim() || env.USERNAME?.trim() || os.userInfo().username,
  });
  return rebaseConfiguredPath(binding, path.resolve(expanded));
}

export function resolveConfigRootFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  physicalArchive: string = resolveArchiveRootFromEnv(env),
): string {
  const explicit = env.TOKENATLAS_CONFIG?.trim();
  if (!explicit) return path.join(path.resolve(physicalArchive), "config");
  // CONFIG retains its existing literal-path contract; STORE overrides expand templates.
  return rebaseConfiguredPath(readCanonicalArchiveRoot(physicalArchive), path.resolve(explicit));
}

