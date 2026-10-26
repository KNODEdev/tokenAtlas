import fs from "node:fs";
import path from "node:path";
import { ATLAS_SNAPSHOT_DATABASE_SUFFIX, ATLAS_SNAPSHOT_MANIFEST_SUFFIX, ATLAS_SNAPSHOT_BARRIER_SUFFIX } from "./snapshot-contracts";
import type { AtlasSnapshotPublishFailpoints } from "./snapshot-contracts";
import { discoverPublishedAtlasSnapshotManifests } from "./snapshot-discovery";

export function removeStalePublicationTemps(poolPath: string, cutoffMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(poolPath);
  } catch {
    return;
  }
  const markers = [
    `${ATLAS_SNAPSHOT_DATABASE_SUFFIX}.tmp-`,
    `${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}.tmp-`,
    `${ATLAS_SNAPSHOT_BARRIER_SUFFIX}.tmp-`,
  ];
  for (const name of names) {
    if (!markers.some((marker) => name.includes(marker))) continue;
    const filePath = path.join(poolPath, name);
    try {
      if (fs.statSync(filePath).mtimeMs <= cutoffMs) fs.rmSync(filePath);
    } catch {
    }
  }
}

/**
 * Validated snapshots kept after a publication, counting the protected one. Each is a
 * full SQLite backup of the database, and recovery only ever reads the newest
 * valid one, so a second complete copy buys nothing for its size.
 */
export const RETAINED_VALIDATED_SNAPSHOTS = 1;

export function retainNewestValidatedSnapshots(
  poolPath: string,
  currentSchemaVersion: number,
  protectedSnapshotId: string,
  failpoints?: AtlasSnapshotPublishFailpoints,
): void {
  // The protected snapshot was just validated in full. Older copies are judged by manifest and
  // file metadata only: hashing and integrity-checking a multi-GB copy only to delete it bought
  // nothing, and recovery validates in full whatever it actually reads.
  const published = discoverPublishedAtlasSnapshotManifests(poolPath, {
    currentSchemaVersion,
    exceptSnapshotId: protectedSnapshotId,
  });
  const keep = new Set<string>([protectedSnapshotId]);
  for (const manifest of published) {
    if (keep.size >= RETAINED_VALIDATED_SNAPSHOTS) break;
    keep.add(manifest.snapshotId);
  }
  for (const manifest of published.filter((item) => !keep.has(item.snapshotId))) {
    const candidate = {
      manifestPath: path.join(poolPath, `${manifest.snapshotId}${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`),
      barrierPath: path.join(poolPath, `${manifest.snapshotId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`),
      databasePath: path.join(poolPath, `${manifest.snapshotId}${ATLAS_SNAPSHOT_DATABASE_SUFFIX}`),
    };
    failpoints?.beforeRetentionDelete?.(manifest.snapshotId);
    // Removing the manifest first makes a partially deleted pair ineligible to readers.
    try {
      if (fs.existsSync(candidate.manifestPath)) fs.rmSync(candidate.manifestPath);
    } catch {
    }
    failpoints?.afterRetentionManifestDelete?.(manifest.snapshotId);
    try {
      if (fs.existsSync(candidate.barrierPath)) fs.rmSync(candidate.barrierPath);
    } catch {
    }
    try {
      if (fs.existsSync(candidate.databasePath)) fs.rmSync(candidate.databasePath);
    } catch {
    }
  }
}
