import type { UsageVendorId } from "../sync/contracts";
import { USAGE_VENDOR_IDS } from "../sync/contracts";
import type { AtlasIndexSnapshotManifest, AtlasSnapshotRevisions, PublishAtlasSnapshotOptions } from "./snapshot-contracts";
import { ATLAS_SNAPSHOT_MANIFEST_VERSION, ATLAS_SNAPSHOT_KIND } from "./snapshot-contracts";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Database } from "./sqlite";
import { probeFactsDigest } from "./probe-facts";
import { databaseSchemaVersion, readRevisions, readVendorDataRevisions, readVendorRowCounts, SnapshotDatabase, validateRequiredSchema } from "./snapshot-database";
import fs from "node:fs";
import { sha256File } from "./snapshot-files";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function integerField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function vendorNumbers(value: unknown): Record<UsageVendorId, number> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<UsageVendorId, number>;
  for (const vendor of USAGE_VENDOR_IDS) {
    const n = value[vendor];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    out[vendor] = n;
  }
  return out;
}

export function parseAtlasSnapshotManifest(value: unknown): AtlasIndexSnapshotManifest | null {
  if (!isRecord(value)) return null;
  const revisionsValue = value.revisions;
  const checksumValue = value.checksum;
  if (!isRecord(revisionsValue) || !isRecord(checksumValue)) return null;
  const data = integerField(revisionsValue, "data");
  const config = integerField(revisionsValue, "config");
  const derived = integerField(revisionsValue, "derived");
  const schemaVersion = integerField(value, "schemaVersion");
  const sizeBytes = integerField(value, "sizeBytes");
  const vendorDataRevisions = vendorNumbers(value.vendorDataRevisions);
  const vendorRowCounts = vendorNumbers(value.vendorRowCounts);
  const snapshotId = stringField(value, "snapshotId");
  const sourceArchiveRoot = stringField(value, "sourceArchiveRoot");
  const sourceMachine = stringField(value, "sourceMachine");
  const createdAt = stringField(value, "createdAt");
  const checksum = stringField(checksumValue, "value");
  const identityFingerprint = stringField(value, "identityFingerprint");
  const registry = stringField(value, "registryDigest");
  const probeFacts = stringField(value, "probeFactsDigest");
  const bindings = stringField(value, "bindingsDigest");
  if (
    value.manifestVersion !== ATLAS_SNAPSHOT_MANIFEST_VERSION ||
    value.kind !== ATLAS_SNAPSHOT_KIND ||
    data === null || data < 0 ||
    config === null || config < 0 ||
    derived === null || derived < 0 ||
    schemaVersion === null || schemaVersion < 0 ||
    sizeBytes === null || sizeBytes < 0 ||
    !vendorDataRevisions || !vendorRowCounts ||
    !snapshotId || !sourceArchiveRoot || !sourceMachine || !createdAt ||
    checksumValue.algorithm !== "sha256" ||
    !checksum || !/^[0-9a-f]{64}$/.test(checksum) ||
    !identityFingerprint || !/^[0-9a-f]{64}$/.test(identityFingerprint) ||
    (bindings !== null && !/^[0-9a-f]{64}$/.test(bindings)) ||
    (schemaVersion >= 24 && (!probeFacts || !/^[0-9a-f]{64}$/.test(probeFacts))) ||
    (registry !== null && !/^[0-9a-f]{64}$/.test(registry)) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return {
    manifestVersion: ATLAS_SNAPSHOT_MANIFEST_VERSION,
    kind: ATLAS_SNAPSHOT_KIND,
    snapshotId,
    schemaVersion,
    revisions: { data, config, derived },
    vendorDataRevisions,
    sourceArchiveRoot,
    sourceMachine,
    createdAt,
    sizeBytes,
    checksum: { algorithm: "sha256", value: checksum },
    vendorRowCounts,
    identityFingerprint,
    ...(registry ? { registryDigest: registry } : {}),
    ...(probeFacts ? { probeFactsDigest: probeFacts } : {}),
    ...(bindings ? { bindingsDigest: bindings } : {}),
  };
}

export function sameNumbers(a: Record<UsageVendorId, number>, b: Record<UsageVendorId, number>): boolean {
  return USAGE_VENDOR_IDS.every((vendor) => a[vendor] === b[vendor]);
}

export function sameRevisions(a: AtlasSnapshotRevisions, b: AtlasSnapshotRevisions): boolean {
  return a.data === b.data && a.config === b.config && a.derived === b.derived;
}

export function identityFingerprint(
  value: Pick<
    AtlasIndexSnapshotManifest,
    | "schemaVersion"
    | "revisions"
    | "vendorDataRevisions"
    | "sourceArchiveRoot"
      | "vendorRowCounts"
      | "registryDigest"
      | "probeFactsDigest"
      | "bindingsDigest"
  >,
): string {
  const vendors = USAGE_VENDOR_IDS.map((vendor) => ({
    vendor,
    revision: value.vendorDataRevisions[vendor],
    rows: value.vendorRowCounts[vendor],
  }));
  return createHash("sha256")
    .update(JSON.stringify({
        schemaVersion: value.schemaVersion,
        ...(value.registryDigest ? { registryDigest: value.registryDigest } : {}),
        ...(value.probeFactsDigest ? { probeFactsDigest: value.probeFactsDigest } : {}),
        ...(value.bindingsDigest ? { bindingsDigest: value.bindingsDigest } : {}),
      revisions: value.revisions,
      vendors,
      sourceArchiveRoot: path.normalize(value.sourceArchiveRoot).replaceAll("\\", "/"),
    }))
    .digest("hex");
}

function legacyIdentityFingerprint(manifest: AtlasIndexSnapshotManifest): string {
  const vendors = USAGE_VENDOR_IDS.map((vendor) => ({
    vendor,
    revision: manifest.vendorDataRevisions[vendor],
    rows: manifest.vendorRowCounts[vendor],
  }));
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      revisions: manifest.revisions,
      vendors,
      sourceArchiveRoot: path.normalize(manifest.sourceArchiveRoot).replaceAll("\\", "/"),
      sizeBytes: manifest.sizeBytes,
      checksum: manifest.checksum.value,
    }))
    .digest("hex");
}

export function manifestIdentityMatches(manifest: AtlasIndexSnapshotManifest): boolean {
  return manifest.identityFingerprint === identityFingerprint(manifest) ||
    manifest.identityFingerprint === legacyIdentityFingerprint(manifest);
}

export function snapshotId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

type AtlasSnapshotIdentityFields = Pick<
  AtlasIndexSnapshotManifest,
  | "schemaVersion"
  | "registryDigest"
  | "probeFactsDigest"
  | "bindingsDigest"
  | "revisions"
  | "vendorDataRevisions"
  | "sourceArchiveRoot"
  | "vendorRowCounts"
>;

export function readSnapshotIdentity(sqlite: Database, archiveRoot: string): AtlasSnapshotIdentityFields {
  const schemaVersion = databaseSchemaVersion(sqlite);
  return {
    schemaVersion,
    ...(schemaVersion >= 24 ? { probeFactsDigest: probeFactsDigest(sqlite) } : {}),
    revisions: readRevisions(sqlite),
    vendorDataRevisions: readVendorDataRevisions(sqlite),
    sourceArchiveRoot: archiveRoot,
    vendorRowCounts: readVendorRowCounts(sqlite),
  };
}

export function buildManifest(
  databasePath: string,
  options: Required<Pick<PublishAtlasSnapshotOptions, "sourceMachine">> & {
    archiveRoot: string;
    now: Date;
    onProgress?: PublishAtlasSnapshotOptions["onProgress"];
  },
  id: string,
): AtlasIndexSnapshotManifest {
  const sqlite = new SnapshotDatabase(databasePath, { readonly: true });
  try {
    options.onProgress?.({ phase: "snapshot-validation", snapshotFile: databasePath });
    // A fresh consistent copy preserves the source state; full scans belong to restore validation.
    const schemaErrors = validateRequiredSchema(sqlite);
    if (schemaErrors.length > 0) throw new Error(schemaErrors.join("; "));
    const identity = readSnapshotIdentity(sqlite, options.archiveRoot);
    options.onProgress?.({ phase: "snapshot-checksum", snapshotFile: databasePath });
    const manifest = {
      manifestVersion: ATLAS_SNAPSHOT_MANIFEST_VERSION,
      kind: ATLAS_SNAPSHOT_KIND,
      snapshotId: id,
      ...identity,
      sourceMachine: options.sourceMachine,
      createdAt: options.now.toISOString(),
      sizeBytes: fs.statSync(databasePath).size,
      checksum: { algorithm: "sha256", value: sha256File(databasePath, (snapshotProcessedBytes, snapshotTotalBytes) => {
        options.onProgress?.({ phase: "snapshot-checksum", snapshotFile: databasePath,
          snapshotProcessedBytes, snapshotTotalBytes });
      }) },
    } satisfies Omit<AtlasIndexSnapshotManifest, "identityFingerprint">;
    return { ...manifest, identityFingerprint: identityFingerprint(manifest) };
  } finally {
    sqlite.close();
  }
}
