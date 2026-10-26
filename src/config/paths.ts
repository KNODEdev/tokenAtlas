import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveCodecSource, archiveSourceIdentity } from "../shared/archive-codec-path";
import {
  ExternalArchivePathError,
  canonicalArchivePath,
  physicalArchivePath,
  readCanonicalArchiveRoot,
} from "./archive-paths";
import {
  expandEnvironmentPath,
  resolveArchiveRootFromEnv,
  resolveConfigRootFromEnvironment,
} from "./path-environment";
export { resolveArchiveRootFromEnv } from "./path-environment";
function resolveArchiveRoot(): string {
  return resolveArchiveRootFromEnv(process.env);
}
export function resolveArchiveLogicalRootFromEnv(
  env: Record<string, string | undefined> = process.env
): string {
  const physical = resolveArchiveRootFromEnv(env);
  return readCanonicalArchiveRoot(physical)?.originalLogicalRoot ?? physical;
}
export const ARCHIVE_ROOT: string = resolveArchiveRoot();
export const ARCHIVE_LOGICAL_ROOT: string = resolveArchiveLogicalRootFromEnv(process.env);
export const ARCHIVE_ROOT_IS_EXPLICIT: boolean = Boolean(process.env.TOKENATLAS_ARCHIVE?.trim());
const ARCHIVE_PATH_BINDING = readCanonicalArchiveRoot(ARCHIVE_ROOT);
/** Physical archive location for filesystem I/O. */
export function archive(...segments: string[]): string {
  return path.join(ARCHIVE_ROOT, ...segments);
}
/** Immutable archive location for identities, declarations and database paths. */
export function archiveLogical(...segments: string[]): string {
  return path.join(ARCHIVE_LOGICAL_ROOT, ...segments);
}
export function toArchiveLogicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const identity = [ARCHIVE_ROOT, ARCHIVE_PATH_BINDING?.originalLogicalRoot].some(root =>
    root && archiveCodecSource(path.relative(root, resolved))) ? archiveSourceIdentity(resolved) : resolved;
  if (!ARCHIVE_PATH_BINDING) return identity;
  try { return canonicalArchivePath(ARCHIVE_PATH_BINDING, identity); }
  catch (error) {
    if (error instanceof ExternalArchivePathError) return identity;
    throw error;
  }
}
export function toArchivePhysicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const representation = (file: string) => archiveCodecSource(path.relative(ARCHIVE_ROOT, file))
    && !fs.existsSync(file) && fs.existsSync(`${archiveSourceIdentity(file)}.zst`) ? `${archiveSourceIdentity(file)}.zst` : file;
  if (!ARCHIVE_PATH_BINDING) return representation(resolved);
  try { return representation(physicalArchivePath(ARCHIVE_PATH_BINDING, resolved)); }
  catch (error) {
    if (error instanceof ExternalArchivePathError) return representation(resolved);
    throw error;
  }
}
export const ATLAS_INDEX_SNAPSHOT_DIRECTORY = "atlas-index-snapshots";

export class AtlasSnapshotPoolLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasSnapshotPoolLocationError";
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function atlasIndexSnapshotPool(
  dbPath: string,
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.TOKENATLAS_SNAPSHOT_DIR?.trim();
  const userHome = env.USERPROFILE?.trim() || os.homedir();
  const expanded = configured?.startsWith("~")
    ? path.join(userHome, configured.slice(1))
    : configured;
  const candidate = path.resolve(
    expanded || path.join(path.dirname(path.resolve(dbPath)), ATLAS_INDEX_SNAPSHOT_DIRECTORY)
  );
  if (path.resolve(dbPath).toLowerCase() === candidate.toLowerCase()) {
    throw new AtlasSnapshotPoolLocationError(
      `Atlas snapshot location must be a directory, not the database file itself: '${candidate}'`
    );
  }
  const forbiddenRoots = [
    resolveArchiveRootFromEnv(env),
    env.OneDrive,
    env.ONEDRIVE,
    env.OneDriveCommercial,
    env.OneDriveConsumer,
  ].filter((root): root is string => Boolean(root?.trim()));
  const forbidden = forbiddenRoots.find((root) => pathIsInside(root, candidate));
  if (forbidden) {
    throw new AtlasSnapshotPoolLocationError(
      `Atlas snapshots must stay outside OneDrive and the shared archive: '${candidate}' is inside '${path.resolve(forbidden)}'`
    );
  }
  return candidate;
}
export function requireArchiveRoot(): string {
  if (fs.existsSync(ARCHIVE_ROOT)) return ARCHIVE_ROOT;
  throw new Error(
    `Archive root does not exist: ${ARCHIVE_ROOT}\n` +
      (ARCHIVE_ROOT_IS_EXPLICIT
        ? "  It comes from TOKENATLAS_ARCHIVE - fix that value in .env."
        : "  It was derived from %OneDrive%. If the archive lives elsewhere on this\n" +
          "  machine, set TOKENATLAS_ARCHIVE in .env (see .env.example).") +
      "\n  It is NOT created automatically on purpose: a local folder that OneDrive\n" +
      "  does not sync would look like a working archive and quietly lose data."
  );
}
export const MACHINE: string =
  process.env.TOKENATLAS_MACHINE?.trim() || process.env.COMPUTERNAME?.trim() || os.hostname();
export const LOGIN: string =
  process.env.TOKENATLAS_LOGIN?.trim() || process.env.USERNAME?.trim() || os.userInfo().username;
export const PROFILE: string = `${MACHINE}-${LOGIN}`;
export const HOME_DIR: string = process.env.USERPROFILE || os.homedir();
export function home(...segments: string[]): string {
  return path.join(HOME_DIR, ...segments);
}
/** Expand paths for stable declaration and database identity. */
export function expandPath(raw: string, roots?: { archive?: string }): string {
  return expandEnvironmentPath(raw, {
    archive: roots?.archive ?? ARCHIVE_LOGICAL_ROOT,
    home: HOME_DIR,
    machine: MACHINE,
    login: LOGIN,
  });
}
/** Expand a declaration and rebase only archive-contained identities for I/O. */
export function expandPhysicalPath(raw: string): string {
  return toArchivePhysicalPath(expandPath(raw));
}
export function archiveProfiles(vendor: string): string[] {
  try {
    return fs
      .readdirSync(archive(vendor), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
export function preferredProfile(vendor: string): string | undefined {
  const all = archiveProfiles(vendor);
  if (all.includes(PROFILE)) return PROFILE;
  if (all.includes(MACHINE)) return MACHINE;
  return all[0];
}
export const PRIVATE_CONFIG_FILES = [
  "projects.json",
  "accounts.json",
  "cycles.json",
  "plans.json",
  "claude-gauge.json",
  "grok-gauge.json",
] as const;
export const REPO_ROOT: string = path.resolve(import.meta.dir, "..", "..");
export function resolveConfigRootFromEnv(
  env: Record<string, string | undefined> = process.env
): string {
  return resolveConfigRootFromEnvironment(env);
}
function resolveConfigRoot(): string {
  return resolveConfigRootFromEnv(process.env);
}
export const CONFIG_ROOT: string = resolveConfigRoot();
export const CONFIG_ROOT_IS_EXPLICIT: boolean = Boolean(process.env.TOKENATLAS_CONFIG?.trim());
export function configFile(name: string): string {
  const mine = path.join(CONFIG_ROOT, name);
  if (fs.existsSync(mine)) return mine;
  if (process.env.TOKENATLAS_FROZEN_CONFIG === "1") return mine;
  const shipped = path.join(REPO_ROOT, name);
  if (fs.existsSync(shipped)) return shipped;
  return mine;
}
export function configWriteTarget(name: string): string {
  // The guarded atomic writer creates parents while holding its archive lease.
  return path.join(CONFIG_ROOT, name);
}
export function conflictCopies(name: string): string[] {
  if (!fs.existsSync(CONFIG_ROOT)) return [];
  const base = name.replace(/\.json$/i, "").toLowerCase();
  try {
    return fs
      .readdirSync(CONFIG_ROOT)
      .filter(
        (f) =>
          f !== name &&
          f.toLowerCase().startsWith(base + "-") &&
          f.toLowerCase().endsWith(".json"),
      )
      .map((f) => path.join(CONFIG_ROOT, f));
  } catch {
    return [];
  }
}
