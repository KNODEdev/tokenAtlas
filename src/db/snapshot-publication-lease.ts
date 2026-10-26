import type { Database } from "./sqlite";
import path from "node:path";
import { SnapshotDatabase } from "./snapshot-database";
import { ATLAS_SNAPSHOT_PUBLICATION_LEASE } from "./snapshot-contracts";
import { publicationWaitSignal } from "./snapshot-files";
import { isRecord } from "./snapshot-manifest";
import { readProcessBirth, syncOwnerAlive } from "../sync/process-owner";

export class AtlasPublicationLeaseLostError extends Error {
  constructor(readonly token: string) {
    super("Atlas snapshot publication lease was lost");
    this.name = "AtlasPublicationLeaseLostError";
  }
}

interface AtlasPublicationClaim {
  token: string;
  renewOrThrow: () => void;
  fenceCommitOrThrow: () => void;
  ownsToken: () => boolean;
  releaseIfOwned: () => void;
}

const ATLAS_PUBLICATION_COMMIT_WINDOW_MS = 60_000;

function publicationClaimOwner(token: string): {
  ownerPid: number; ownerProcessStart?: string; startedAt: string;
} | null {
  let owner: unknown;
  try { owner = JSON.parse(token); } catch { return null; }
  // UUID-only claims from older versions retain their time-based expiry.
  if (!isRecord(owner) || owner.kind !== "atlas-snapshot-publication"
    || typeof owner.ownerPid !== "number" || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0
    || typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt))
    || (owner.ownerProcessStart !== undefined && typeof owner.ownerProcessStart !== "string")) return null;
  return { ownerPid: owner.ownerPid, ownerProcessStart: owner.ownerProcessStart, startedAt: owner.startedAt };
}

function openPublicationLease(poolPath: string): Database {
  const sqlite = new SnapshotDatabase(path.join(poolPath, ATLAS_SNAPSHOT_PUBLICATION_LEASE), { create: true });
  sqlite.exec("PRAGMA synchronous = FULL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS publication_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      renewed_at INTEGER NOT NULL
    )
  `);
  return sqlite;
}

function rollbackLease(sqlite: Database): void {
  try {
    sqlite.exec("ROLLBACK");
  } catch {
  }
}

export function acquirePublicationClaim(
  poolPath: string,
  timeoutMs: number,
  staleMs: number,
): AtlasPublicationClaim {
  const deadline = Date.now() + timeoutMs;
  // Keep ownership in the opaque token so existing lease databases need no schema migration.
  const token = JSON.stringify({
    kind: "atlas-snapshot-publication",
    nonce: crypto.randomUUID(),
    ownerPid: process.pid,
    ownerProcessStart: readProcessBirth(process.pid)?.identity,
    startedAt: new Date().toISOString(),
  });
  let lastOwner: ReturnType<typeof publicationClaimOwner> = null;
  for (;;) {
    let acquired = false;
    const sqlite = openPublicationLease(poolPath);
    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const observed = sqlite
        .query("SELECT token, renewed_at FROM publication_lease WHERE id = 1")
        .get() as { token: string; renewed_at: number } | null;
      lastOwner = observed ? publicationClaimOwner(observed.token) : null;
      const renewedAt = Date.now();
      if (!observed) {
        const inserted = sqlite
          .query("INSERT OR IGNORE INTO publication_lease (id, token, renewed_at) VALUES (1, ?, ?)")
          .run(token, renewedAt);
        acquired = inserted.changes === 1;
      } else if ((lastOwner && !syncOwnerAlive(lastOwner)) || renewedAt - observed.renewed_at > staleMs) {
        const replaced = sqlite
          .query(
            `UPDATE publication_lease
                SET token = ?, renewed_at = ?
              WHERE id = 1 AND token = ? AND renewed_at = ?`,
          )
          .run(token, renewedAt, observed.token, observed.renewed_at);
        acquired = replaced.changes === 1;
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      rollbackLease(sqlite);
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(String(error))) throw error;
    } finally {
      sqlite.close();
    }
    if (acquired) {
      const renewWithWindow = (windowMs: number): void => {
        const lease = openPublicationLease(poolPath);
        try {
          // A future watermark fences the bounded non-transactional rename window from stale takeover.
          const renewed = lease
            .query("UPDATE publication_lease SET renewed_at = ? WHERE id = 1 AND token = ?")
            .run(Date.now() + windowMs, token);
          if (renewed.changes !== 1) throw new AtlasPublicationLeaseLostError(token);
        } finally {
          lease.close();
        }
      };
      return {
        token,
        renewOrThrow: () => renewWithWindow(0),
        fenceCommitOrThrow: () => renewWithWindow(Math.max(staleMs, ATLAS_PUBLICATION_COMMIT_WINDOW_MS)),
        ownsToken: () => {
          const lease = openPublicationLease(poolPath);
          try {
            const owner = lease
              .query("SELECT token FROM publication_lease WHERE id = 1")
              .get() as { token: string } | null;
            return owner?.token === token;
          } finally {
            lease.close();
          }
        },
        releaseIfOwned: () => {
          const lease = openPublicationLease(poolPath);
          try {
            lease.exec("BEGIN IMMEDIATE");
            const owner = lease
              .query("SELECT token FROM publication_lease WHERE id = 1")
              .get() as { token: string } | null;
            if (owner?.token === token) {
              lease.query("DELETE FROM publication_lease WHERE id = 1 AND token = ?").run(token);
            }
            lease.exec("COMMIT");
          } catch {
            rollbackLease(lease);
          } finally {
            lease.close();
          }
        },
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the Atlas snapshot publication lease at '${poolPath}'`
        + (lastOwner ? ` (publisher PID ${lastOwner.ownerPid})` : "") + ". No snapshot was published.");
    }
    Atomics.wait(publicationWaitSignal, 0, 0, 20);
  }
}
