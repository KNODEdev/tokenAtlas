import type { AtlasSnapshotPublishResult, AtlasIndexSnapshotManifest, AtlasNewestValidSnapshot } from "../db/snapshot-contracts";
import { AtlasSnapshotDiscoveryError } from "../db/snapshot-contracts";

export interface AtlasSnapshotPublicationState {
  running: boolean;
  mode: "automatic" | "manual" | null;
  started_at: string | null;
  finished_at: string | null;
  result: AtlasSnapshotPublishResult | null;
  error: string | null;
}

type AtlasSnapshotApiManifest = Omit<AtlasIndexSnapshotManifest, "sourceArchiveRoot">;

interface AtlasSnapshotApiResult extends Omit<
  AtlasSnapshotPublishResult,
  "databasePath" | "manifestPath" | "manifest" | "validation"
> {
  manifest: AtlasSnapshotApiManifest | null;
  validation: (Omit<NonNullable<AtlasSnapshotPublishResult["validation"]>, "manifest"> & {
    manifest: AtlasSnapshotApiManifest | null;
  }) | null;
}

interface AtlasSnapshotEndpointContext {
  snapshotPublisher?: (mode: "automatic" | "manual") => AtlasSnapshotPublishResult;
  snapshotDiscovery?: () => AtlasNewestValidSnapshot | null;
}

const atlasSnapshotPublicationState: AtlasSnapshotPublicationState = {
  running: false,
  mode: null,
  started_at: null,
  finished_at: null,
  result: null,
  error: null,
};

function runAtlasSnapshotPublication(
  ctx: AtlasSnapshotEndpointContext,
  mode: "automatic" | "manual",
): AtlasSnapshotPublishResult | null {
  if (atlasSnapshotPublicationState.running || !ctx.snapshotPublisher) return null;
  Object.assign(atlasSnapshotPublicationState, {
    running: true,
    mode,
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  });
  try {
    const result = ctx.snapshotPublisher(mode);
    Object.assign(atlasSnapshotPublicationState, {
      running: false,
      finished_at: new Date().toISOString(),
      result,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Object.assign(atlasSnapshotPublicationState, {
      running: false,
      finished_at: new Date().toISOString(),
      error: message,
    });
    if (mode === "manual") throw error;
    console.warn(`[tokenAtlas snapshot] automatic publication failed: ${message}`);
    return null;
  }
}

function atlasSnapshotManifestForApi(
  manifest: AtlasIndexSnapshotManifest | null,
): AtlasSnapshotApiManifest | null {
  if (!manifest) return null;
  const { sourceArchiveRoot: _sourceArchiveRoot, ...sanitized } = manifest;
  return sanitized;
}

function atlasSnapshotResultForApi(result: AtlasSnapshotPublishResult | null): AtlasSnapshotApiResult | null {
  if (!result) return null;
  return {
    status: result.status,
    reason: result.reason,
    snapshotId: result.snapshotId,
    manifest: atlasSnapshotManifestForApi(result.manifest),
    validation: result.validation
      ? {
          valid: result.validation.valid,
          compatible: result.validation.compatible,
          manifest: atlasSnapshotManifestForApi(result.validation.manifest),
          errors: result.validation.errors,
        }
      : null,
    leaseLostAfterCommit: result.leaseLostAfterCommit,
  };
}

function atlasSnapshotStateForApi(newestValid: AtlasNewestValidSnapshot | null) {
  return {
    ...atlasSnapshotPublicationState,
    result: atlasSnapshotResultForApi(atlasSnapshotPublicationState.result),
    error: atlasSnapshotPublicationState.error ? "Atlas snapshot publication failed" : null,
    newest_valid: newestValid,
    discovery_error: null,
  };
}

export function handleIndexSnapshot(ctx: AtlasSnapshotEndpointContext, req: Request): Response {
  if (req.method === "POST") {
    try {
      const result = runAtlasSnapshotPublication(ctx, "manual");
      if (!result) {
        return Response.json({ error: "Atlas snapshot publication is already running" }, { status: 409 });
      }
    } catch {
      return Response.json(
        {
          ...atlasSnapshotStateForApi(null),
          error: "Atlas snapshot publication failed",
        },
        { status: 500 },
      );
    }
  } else if (req.method !== "GET") {
    return Response.json({ error: `Method ${req.method} not allowed` }, { status: 405 });
  }

  try {
    return Response.json(atlasSnapshotStateForApi(ctx.snapshotDiscovery?.() ?? null));
  } catch (error) {
    const discoveryError = error instanceof AtlasSnapshotDiscoveryError
      ? { code: error.code, stage: error.stage }
      : { code: "snapshot-pool-read-failed", stage: "discovery" };
    return Response.json(
      { ...atlasSnapshotStateForApi(null), discovery_error: discoveryError },
      { status: 503 },
    );
  }
}

export function getAtlasSnapshotPublicationState(): AtlasSnapshotPublicationState {
  return atlasSnapshotPublicationState;
}
