import { describe, expect, test } from "bun:test";
import type {
  AtlasIndexSnapshotManifest,
  AtlasNewestValidSnapshot,
  AtlasSnapshotPublishResult,
} from "../db/snapshot";
import { handleIndexSnapshot } from "./api";

describe("index snapshot API", () => {
  test("GET discovers the newest valid pool snapshot and keeps paths out of the response", async () => {
    const manifest: AtlasIndexSnapshotManifest = {
      manifestVersion: 2,
      kind: "tokenatlas-index",
      snapshotId: "snapshot-1",
      schemaVersion: 14,
      revisions: { data: 7, config: 3, derived: 7 },
      vendorDataRevisions: { codex: 7, claude: 6, opencode: 5, grok: 4, gemini: 3 },
      sourceArchiveRoot: "C:\\private\\archive",
      sourceMachine: "pc-a",
      createdAt: "2026-08-31T12:00:00.000Z",
      sizeBytes: 4096,
      checksum: { algorithm: "sha256", value: "a".repeat(64) },
      vendorRowCounts: { codex: 70, claude: 60, opencode: 50, grok: 40, gemini: 30 },
      identityFingerprint: "b".repeat(64),
    };
    const publication: AtlasSnapshotPublishResult = {
      status: "created",
      reason: null,
      snapshotId: manifest.snapshotId,
      databasePath: "C:\\private\\pool\\snapshot-1.atlas.sqlite",
      manifestPath: "C:\\private\\pool\\snapshot-1.atlas-manifest.json",
      manifest,
      validation: { valid: true, compatible: true, manifest, errors: [] },
      leaseLostAfterCommit: false,
    };
    const newest: AtlasNewestValidSnapshot = {
      id: "snapshot-1",
      created_at: "2026-08-31T12:00:00.000Z",
      age_seconds: 120,
      revisions: { data: 7, config: 3, derived: 7 },
      vendor_revisions: { codex: 7, claude: 6, opencode: 5, grok: 4, gemini: 3 },
      compatible: true,
      validation: "manifest-only",
    };
    const ctx = {
      snapshotPublisher: () => publication,
      snapshotDiscovery: () => newest,
    };

    const post = await handleIndexSnapshot(
      ctx,
      new Request("http://localhost/api/index-snapshot", { method: "POST" }),
    ).json() as Record<string, any>;
    expect(post.result.status).toBe("created");

    const response = handleIndexSnapshot(ctx, new Request("http://localhost/api/index-snapshot"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.newest_valid).toEqual(newest);
    expect(body.result).toMatchObject({ status: "created", snapshotId: "snapshot-1" });
    expect(body.result).not.toHaveProperty("databasePath");
    expect(body.result).not.toHaveProperty("manifestPath");
    expect(body.result.manifest).not.toHaveProperty("sourceArchiveRoot");
    expect(JSON.stringify(body)).not.toContain("C:\\private");
  });

  test("GET reports pool read failure separately from an empty pool", async () => {
    const response = handleIndexSnapshot(
      { snapshotDiscovery: () => { throw new Error("C:\\private\\pool is unavailable"); } },
      new Request("http://localhost/api/index-snapshot"),
    );
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, any>;
    expect(body.newest_valid).toBeNull();
    expect(body.discovery_error).toEqual({ code: "snapshot-pool-read-failed", stage: "discovery" });
    expect(JSON.stringify(body)).not.toContain("C:\\private");
  });
});
