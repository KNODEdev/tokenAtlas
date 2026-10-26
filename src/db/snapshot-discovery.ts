import fs from "node:fs";
import path from "node:path";
import type { AtlasSnapshotCandidate, AtlasNewestValidSnapshot, AtlasIndexSnapshotManifest } from "./snapshot-contracts";
import { ATLAS_SNAPSHOT_MANIFEST_SUFFIX, AtlasSnapshotDiscoveryError, ATLAS_SNAPSHOT_DATABASE_SUFFIX, ATLAS_SNAPSHOT_BARRIER_SUFFIX, MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION } from "./snapshot-contracts";
import { validateAtlasSnapshotCandidate } from "./snapshot-validation";
import { currentAtlasSchemaVersion } from "./snapshot-schema";
import { parseAtlasSnapshotManifest, isRecord, manifestIdentityMatches } from "./snapshot-manifest";

export function discoverAtlasSnapshotCandidates(
  poolPath: string,
  options: { currentSchemaVersion?: number; exceptSnapshotId?: string } = {},
): AtlasSnapshotCandidate[] {
  if (!fs.existsSync(poolPath)) return [];
  const excluded = options.exceptSnapshotId == null
    ? null
    : `${options.exceptSnapshotId}${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`;
  try {
    return fs
      .readdirSync(poolPath)
      .filter((name) => name.endsWith(ATLAS_SNAPSHOT_MANIFEST_SUFFIX) && name !== excluded)
      .map((name) => validateAtlasSnapshotCandidate(path.join(poolPath, name), options))
      .sort((a, b) => b.sortTime.localeCompare(a.sortTime) || b.snapshotId.localeCompare(a.snapshotId));
  } catch {
    throw new AtlasSnapshotDiscoveryError();
  }
}

/**
 * A published pair judged from its manifest and file metadata alone: parseable manifest named
 * after its id, matching identity, database of the recorded size and a durable barrier. It
 * reads no database bytes; full validation (checksum, integrity) is for snapshots to be used.
 */
function structurallyPublishedManifest(poolPath: string, name: string): AtlasIndexSnapshotManifest | null {
  const manifestPath = path.join(poolPath, name);
  let decoded: unknown;
  try {
    decoded = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const manifest = parseAtlasSnapshotManifest(decoded);
  if (!manifest) return null;
  const nameId = name.slice(0, -ATLAS_SNAPSHOT_MANIFEST_SUFFIX.length);
  const databasePath = path.join(poolPath, `${nameId}${ATLAS_SNAPSHOT_DATABASE_SUFFIX}`);
  const barrierPath = path.join(poolPath, `${nameId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`);
  let databaseStat: fs.Stats;
  let barrierStat: fs.Stats;
  try {
    databaseStat = fs.statSync(databasePath);
    barrierStat = fs.statSync(barrierPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    manifest.snapshotId !== nameId ||
    !manifestIdentityMatches(manifest) ||
    !databaseStat.isFile() ||
    !barrierStat.isFile() ||
    databaseStat.size !== manifest.sizeBytes
  ) {
    return null;
  }
  return manifest;
}

export function discoverNewestValidAtlasSnapshot(
  poolPath: string,
  options: { currentSchemaVersion?: number; now?: Date } = {},
): AtlasNewestValidSnapshot | null {
  const currentSchema = options.currentSchemaVersion ?? currentAtlasSchemaVersion();
  const now = options.now ?? new Date();
  try {
    const manifests = fs
      .readdirSync(poolPath)
      .filter((name) => name.endsWith(ATLAS_SNAPSHOT_MANIFEST_SUFFIX))
      .map((name) => structurallyPublishedManifest(poolPath, name))
      .filter((manifest): manifest is AtlasIndexSnapshotManifest => manifest !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.snapshotId.localeCompare(a.snapshotId));
    const newest = manifests[0];
    if (!newest) return null;
    return {
      id: newest.snapshotId,
      created_at: newest.createdAt,
      age_seconds: Math.max(0, Math.floor((now.getTime() - Date.parse(newest.createdAt)) / 1000)),
      revisions: newest.revisions,
      vendor_revisions: newest.vendorDataRevisions,
      compatible:
        newest.schemaVersion >= MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION &&
        newest.schemaVersion <= currentSchema,
      validation: "manifest-only",
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new AtlasSnapshotDiscoveryError();
  }
}

/** Structurally published, compatible snapshots, newest first, without reading their databases. */
export function discoverPublishedAtlasSnapshotManifests(
  poolPath: string,
  options: { currentSchemaVersion?: number; exceptSnapshotId?: string } = {},
): AtlasIndexSnapshotManifest[] {
  const currentSchema = options.currentSchemaVersion ?? currentAtlasSchemaVersion();
  const excluded = options.exceptSnapshotId == null
    ? null
    : `${options.exceptSnapshotId}${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`;
  try {
    return fs
      .readdirSync(poolPath)
      .filter((name) => name.endsWith(ATLAS_SNAPSHOT_MANIFEST_SUFFIX) && name !== excluded)
      .map((name) => structurallyPublishedManifest(poolPath, name))
      .filter((manifest): manifest is AtlasIndexSnapshotManifest => manifest !== null
        && manifest.schemaVersion >= MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION && manifest.schemaVersion <= currentSchema)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.snapshotId.localeCompare(a.snapshotId));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw new AtlasSnapshotDiscoveryError();
  }
}
