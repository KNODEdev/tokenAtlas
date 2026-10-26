import type { AtlasSnapshotCandidate, AtlasSnapshotPublishResult, PublishAtlasSnapshotOptions } from "./snapshot-contracts";
import path from "node:path";
import { ARCHIVE_ROOT, atlasIndexSnapshotPool, MACHINE } from "../config/paths";
import fs from "node:fs";
import { currentAtlasSchemaVersion } from "./snapshot-schema";
import { acquirePublicationClaim, AtlasPublicationLeaseLostError } from "./snapshot-publication-lease";
import { snapshotId, readSnapshotIdentity, identityFingerprint, buildManifest } from "./snapshot-manifest";
import { ATLAS_SNAPSHOT_DATABASE_SUFFIX, ATLAS_SNAPSHOT_MANIFEST_SUFFIX } from "./snapshot-contracts";
import { removeStalePublicationTemps, retainNewestValidatedSnapshots } from "./snapshot-retention";
import { discoverNewestValidAtlasSnapshot, discoverAtlasSnapshotCandidates } from "./snapshot-discovery";
import { SnapshotDatabase } from "./snapshot-database";
import { syncFile, renamePublicationFile, establishDurablePair } from "./snapshot-files";
import { confirmPublishedSnapshot } from "./snapshot-validation";
import { backupSnapshotDatabase } from "./snapshot-backup";

function resultFromCandidate(
  candidate: AtlasSnapshotCandidate,
  status: "reused" | "skipped",
  reason: AtlasSnapshotPublishResult["reason"],
): AtlasSnapshotPublishResult {
  return {
    status,
    reason,
    snapshotId: candidate.snapshotId,
    databasePath: candidate.databasePath,
    manifestPath: candidate.manifestPath,
    manifest: candidate.manifest,
    validation: {
      valid: candidate.valid,
      compatible: candidate.compatible,
      manifest: candidate.manifest,
      errors: candidate.errors,
    },
    leaseLostAfterCommit: false,
  };
}

/** SQLite backup retains every page, including the freelist and committed WAL pages. */
function databaseBytes(sqlite: SnapshotDatabase): number | undefined {
  try {
    const pragma = (name: string) => Number(Object.values(sqlite.query(`PRAGMA ${name}`).get() as object)[0]);
    const bytes = pragma("page_count") * pragma("page_size");
    return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function leaseLostPublishResult(): AtlasSnapshotPublishResult {
  return {
    status: "aborted",
    reason: "lease-lost",
    snapshotId: null,
    databasePath: null,
    manifestPath: null,
    manifest: null,
    validation: null,
    leaseLostAfterCommit: false,
  };
}

export function publishAtlasSnapshot(options: PublishAtlasSnapshotOptions): AtlasSnapshotPublishResult {
  const archiveRoot = path.resolve(options.archiveRoot ?? ARCHIVE_ROOT);
  const poolPath = path.resolve(options.poolPath ?? atlasIndexSnapshotPool(options.dbPath));
  const sourceMachine = options.sourceMachine ?? MACHINE;
  const now = options.now ?? new Date();
  const currentSchemaVersion = options.currentSchemaVersion ?? currentAtlasSchemaVersion();
  const leaseStaleMs = options.leaseStaleMs ?? 30 * 60_000;
  const mayReuse = !options.requireFreshCopy;
  if (!fs.existsSync(poolPath)) fs.mkdirSync(poolPath, { recursive: true });
  for (;;) {
    options.onProgress?.({ phase: "snapshot-wait" });
    const claim = acquirePublicationClaim(
      poolPath,
      options.lockTimeoutMs ?? 30_000,
      leaseStaleMs,
    );
    const id = snapshotId(now);
    const databasePath = path.join(poolPath, `${id}${ATLAS_SNAPSHOT_DATABASE_SUFFIX}`);
    const manifestPath = path.join(poolPath, `${id}${ATLAS_SNAPSHOT_MANIFEST_SUFFIX}`);
    const tempToken = `${process.pid}-${crypto.randomUUID()}`;
    const databaseTemp = `${databasePath}.tmp-${tempToken}`;
    const manifestTemp = `${manifestPath}.tmp-${tempToken}`;
    try {
      options.failpoints?.afterClaimAcquired?.(claim.token, claim.renewOrThrow);
      removeStalePublicationTemps(poolPath, now.getTime() - leaseStaleMs);
      if (mayReuse && options.mode === "automatic") {
        const newest = discoverNewestValidAtlasSnapshot(poolPath, { currentSchemaVersion, now });
        if (newest?.created_at.slice(0, 10) === now.toISOString().slice(0, 10)) {
          const candidate = discoverAtlasSnapshotCandidates(poolPath, { currentSchemaVersion })
            .find((item) => item.snapshotId === newest.id && item.valid && item.compatible);
          if (candidate) return resultFromCandidate(candidate, "skipped", "daily-limit");
        }
      }
      const existing = mayReuse
        ? discoverAtlasSnapshotCandidates(poolPath, { currentSchemaVersion })
          .filter((candidate) => candidate.valid && candidate.compatible && candidate.manifest)
        : [];
      const source = new SnapshotDatabase(options.dbPath, { readonly: true });
      try {
        const sourceIdentity = readSnapshotIdentity(source, archiveRoot);
        if (sourceIdentity.schemaVersion > currentSchemaVersion) {
          throw new Error("source database schema is newer than this application");
        }
        const sourceFingerprint = identityFingerprint(sourceIdentity);
        const identical = existing.find(
          (candidate) => identityFingerprint(candidate.manifest!) === sourceFingerprint,
        );
        if (identical) {
          return resultFromCandidate(
            identical,
            options.mode === "manual" ? "reused" : "skipped",
            options.mode === "manual" ? "identical-snapshot" : "unchanged-data",
          );
        }
        options.failpoints?.beforeDatabaseCopy?.();
        if (options.onProgress) {
          const snapshotTotalBytes = databaseBytes(source);
          options.onProgress({ phase: "snapshot-copy", snapshotFile: databaseTemp,
            ...(snapshotTotalBytes ? { snapshotTotalBytes } : {}) });
        }
        backupSnapshotDatabase(options.dbPath, databaseTemp);
      } finally {
        source.close();
      }
      // Snapshot bootstrap must not inherit another machine's pending transport side effects.
      // Only the COPY is scrubbed; the source queue remains authoritative and recoverable.
      const copy = new SnapshotDatabase(databaseTemp);
      try {
        // A published snapshot must be self-contained even when its source uses WAL.
        copy.exec("PRAGMA journal_mode=DELETE");
        if (copy.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gauge_journal_outbox'").get()) {
          copy.exec("DELETE FROM gauge_journal_outbox");
        }
      } finally { copy.close(); }
      syncFile(databaseTemp);
      const manifest = buildManifest(databaseTemp, { archiveRoot, sourceMachine, now, onProgress: options.onProgress }, id);
      if (manifest.schemaVersion > currentSchemaVersion) {
        throw new Error("source database schema is newer than this application");
      }
      const currentIdentity = identityFingerprint(manifest);
      const identical = existing.find(
        (candidate) => identityFingerprint(candidate.manifest!) === currentIdentity,
      );
      if (identical) {
        return resultFromCandidate(
          identical,
          options.mode === "manual" ? "reused" : "skipped",
          options.mode === "manual" ? "identical-snapshot" : "unchanged-data",
        );
      }
      fs.writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      syncFile(manifestTemp);
      claim.renewOrThrow();
      options.failpoints?.afterPreCommitRenewal?.(claim.token);
      claim.fenceCommitOrThrow();
      options.onProgress?.({ phase: "snapshot-publication", snapshotFile: databaseTemp });
      renamePublicationFile(databaseTemp, databasePath);
      options.failpoints?.afterDatabaseRename?.();
      renamePublicationFile(manifestTemp, manifestPath);
      options.failpoints?.afterManifestRename?.();
      const barrierPath = establishDurablePair(poolPath, id, databasePath, manifestPath);
      const ownedAfterCommit = claim.ownsToken();
      const candidate = confirmPublishedSnapshot(
        manifest,
        { databasePath, manifestPath, barrierPath },
        currentSchemaVersion,
      );
      if (!candidate.valid || !candidate.compatible) {
        throw new Error(`published snapshot failed validation: ${candidate.errors.join("; ")}`);
      }
      const createdResult = (leaseLostAfterCommit: boolean): AtlasSnapshotPublishResult => ({
        status: "created",
        reason: null,
        snapshotId: id,
        databasePath,
        manifestPath,
        manifest,
        validation: {
          valid: candidate.valid,
          compatible: candidate.compatible,
          manifest: candidate.manifest,
          errors: candidate.errors,
        },
        leaseLostAfterCommit,
      });
      if (!ownedAfterCommit) return createdResult(true);
      try {
        claim.renewOrThrow();
      } catch (error) {
        if (error instanceof AtlasPublicationLeaseLostError) return createdResult(true);
        throw error;
      }
      options.onProgress?.({ phase: "snapshot-retention" });
      retainNewestValidatedSnapshots(poolPath, currentSchemaVersion, id, options.failpoints);
      return createdResult(false);
    } catch (error) {
      if (error instanceof AtlasPublicationLeaseLostError) {
        options.failpoints?.afterLeaseLost?.(claim.token);
        return leaseLostPublishResult();
      }
      throw error;
    } finally {
      for (const file of [databaseTemp, `${databaseTemp}-journal`, `${databaseTemp}-wal`, `${databaseTemp}-shm`]) {
        try { if (fs.existsSync(file)) fs.rmSync(file); }
        catch {
          // A failed Windows SQLite open can briefly hold an unpublished temp.
        }
      }
      try {
        if (fs.existsSync(manifestTemp)) fs.rmSync(manifestTemp);
      } catch {
      }
      claim.releaseIfOwned();
    }
  }
}
