import type { SyncMode, SyncRunResult } from "../sync/contracts";

export type BootstrapSyncPhase = { mode: SyncMode; collection?: "mirror-only" | "archive" };
export type BootstrapSyncStart = (phase: BootstrapSyncPhase) => Promise<SyncRunResult | null> | null;

export interface BootstrapCatchUpResult {
  collection: SyncRunResult | null;
  import: SyncRunResult | null;
  complete: boolean;
}

function complete(run: SyncRunResult | null): boolean {
  return !!run && run.status === "success"
    && run.vendors.every(vendor => vendor.status === "success" && vendor.inputsComplete !== false);
}

/** Fresh recovery collects changed originals, then imports retained archive bytes. */
export function startBootstrapCatchUp(
  mode: "full" | "incremental",
  recoveryId: string | null,
  start: BootstrapSyncStart,
): Promise<BootstrapCatchUpResult> | null {
  if (mode === "full" && !recoveryId) return null;
  const first = start(mode === "full" ? { mode: "incremental", collection: "mirror-only" }
    : { mode: "incremental" });
  if (!first) return null;
  return first.then(async collection => {
    if (mode === "incremental") return { collection: null, import: collection, complete: complete(collection) };
    const second = start({ mode: "incremental", collection: "archive" });
    const imported = second ? await second : null;
    return { collection, import: imported, complete: complete(collection) && complete(imported) };
  });
}
