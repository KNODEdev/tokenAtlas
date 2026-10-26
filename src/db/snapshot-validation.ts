import fs from "node:fs";
import type { Database } from "./sqlite";
import { validateProbeFacts, probeFactsDigest } from "./probe-facts";
import type { AtlasIndexSnapshotManifest, AtlasSnapshotValidation, AtlasSnapshotCandidate } from "./snapshot-contracts";
import { currentAtlasSchemaVersion } from "./snapshot-schema";
import { MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION, ATLAS_SNAPSHOT_MANIFEST_SUFFIX, ATLAS_SNAPSHOT_DATABASE_SUFFIX, ATLAS_SNAPSHOT_BARRIER_SUFFIX } from "./snapshot-contracts";
import { sha256File } from "./snapshot-files";
import { manifestIdentityMatches, sameRevisions, sameNumbers, parseAtlasSnapshotManifest } from "./snapshot-manifest";
import { SnapshotDatabase, sqliteIntegrityErrors, validateRequiredSchema, databaseSchemaVersion, readRevisions, readVendorDataRevisions, readVendorRowCounts } from "./snapshot-database";
import path from "node:path";

export function validateAtlasSnapshotFiles(
  databasePath: string,
  manifest: AtlasIndexSnapshotManifest,
  options: { currentSchemaVersion?: number } = {},
): AtlasSnapshotValidation {
  const errors: string[] = [];
  const currentSchema = options.currentSchemaVersion ?? currentAtlasSchemaVersion();
  const compatible =
    manifest.schemaVersion >= MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION &&
    manifest.schemaVersion <= currentSchema;
  if (!compatible) errors.push("snapshot schema is not compatible with this application");
  if (!fs.existsSync(databasePath)) {
    errors.push("snapshot database is missing");
    return { valid: false, compatible, manifest, errors };
  }
  const stat = fs.statSync(databasePath);
  if (stat.size !== manifest.sizeBytes) errors.push("snapshot size does not match its manifest");
  if (sha256File(databasePath) !== manifest.checksum.value) {
    errors.push("snapshot checksum does not match its manifest");
  }
  if (!manifestIdentityMatches(manifest)) {
    errors.push("snapshot identity does not match its manifest");
  }
  let sqlite: Database | null = null;
  try {
    sqlite = new SnapshotDatabase(databasePath, { readonly: true, strict: true });
    errors.push(...sqliteIntegrityErrors(sqlite));
    errors.push(...validateRequiredSchema(sqlite));
    if (databaseSchemaVersion(sqlite) !== manifest.schemaVersion) {
      errors.push("snapshot database schema version does not match its manifest");
    }
    if (manifest.schemaVersion >= 24) {
      validateProbeFacts(sqlite);
      if (probeFactsDigest(sqlite) !== manifest.probeFactsDigest) errors.push("snapshot probe facts digest mismatch");
    }
    if (!sameRevisions(readRevisions(sqlite), manifest.revisions)) {
      errors.push("snapshot revisions do not match its manifest");
    }
    if (!sameNumbers(readVendorDataRevisions(sqlite), manifest.vendorDataRevisions)) {
      errors.push("snapshot vendor revisions do not match its manifest");
    }
    if (!sameNumbers(readVendorRowCounts(sqlite), manifest.vendorRowCounts)) {
      errors.push("snapshot vendor row counts do not match its manifest");
    }
  } catch {
    errors.push("snapshot database could not be opened or inspected");
  } finally {
    sqlite?.close();
  }
  return { valid: errors.length === 0, compatible, manifest, errors: [...new Set(errors)] };
}

function readManifest(manifestPath: string): AtlasIndexSnapshotManifest | null {
  try {
    return parseAtlasSnapshotManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function validateAtlasSnapshotCandidate(
  manifestPath: string,
  options: { currentSchemaVersion?: number } = {},
): AtlasSnapshotCandidate {
  const fileName = path.basename(manifestPath);
  const nameId = fileName.endsWith(ATLAS_SNAPSHOT_MANIFEST_SUFFIX)
    ? fileName.slice(0, -ATLAS_SNAPSHOT_MANIFEST_SUFFIX.length)
    : fileName;
  const databasePath = path.join(path.dirname(manifestPath), `${nameId}${ATLAS_SNAPSHOT_DATABASE_SUFFIX}`);
  const barrierPath = path.join(path.dirname(manifestPath), `${nameId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`);
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    let sortTime = "1970-01-01T00:00:00.000Z";
    try {
      sortTime = fs.statSync(manifestPath).mtime.toISOString();
    } catch {
    }
    return {
      snapshotId: nameId,
      databasePath,
      manifestPath,
      barrierPath,
      sortTime,
      valid: false,
      compatible: false,
      manifest: null,
      errors: ["snapshot manifest is invalid"],
    };
  }
  let validation: AtlasSnapshotValidation;
  try {
    validation = validateAtlasSnapshotFiles(databasePath, manifest, options);
  } catch {
    validation = {
      valid: false,
      compatible:
        manifest.schemaVersion >= MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION &&
        manifest.schemaVersion <= (options.currentSchemaVersion ?? currentAtlasSchemaVersion()),
      manifest,
      errors: ["snapshot files changed while they were being validated"],
    };
  }
  const errors = [...validation.errors];
  if (manifest.snapshotId !== nameId) errors.push("snapshot id does not match its manifest filename");
  if (!fs.existsSync(barrierPath)) errors.push("snapshot durable publication barrier is missing");
  return {
    snapshotId: nameId,
    databasePath,
    manifestPath,
    barrierPath,
    sortTime: manifest.createdAt,
    ...validation,
    valid: validation.valid && errors.length === 0,
    errors,
  };
}

/**
 * Confirms a pair this process has just published. `buildManifest` hashed and inspected these
 * exact bytes under their temporary name and a rename does not change them, so reading the
 * whole database again would only repeat that work. What publication itself added is checked:
 * the manifest as stored, the final names, the file size and the durable barrier.
 */
export function confirmPublishedSnapshot(
  built: AtlasIndexSnapshotManifest,
  paths: { databasePath: string; manifestPath: string; barrierPath: string },
  currentSchemaVersion: number,
): AtlasSnapshotValidation {
  const errors: string[] = [];
  const compatible =
    built.schemaVersion >= MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION &&
    built.schemaVersion <= currentSchemaVersion;
  if (!compatible) errors.push("snapshot schema is not compatible with this application");
  const stored = readManifest(paths.manifestPath);
  if (!stored) {
    errors.push("snapshot manifest is invalid");
  } else {
    if (JSON.stringify(stored) !== JSON.stringify(parseAtlasSnapshotManifest(built))) {
      errors.push("snapshot manifest does not match the inspected database");
    }
    if (!manifestIdentityMatches(stored)) errors.push("snapshot identity does not match its manifest");
  }
  let sizeBytes: number | null = null;
  try {
    sizeBytes = fs.statSync(paths.databasePath).size;
  } catch {
    errors.push("snapshot database is missing");
  }
  if (sizeBytes !== null && sizeBytes !== built.sizeBytes) errors.push("snapshot size does not match its manifest");
  if (!fs.existsSync(paths.barrierPath)) errors.push("snapshot durable publication barrier is missing");
  return { valid: errors.length === 0, compatible, manifest: stored ?? built, errors };
}
