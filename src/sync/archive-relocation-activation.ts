import type { ArchiveRelocationActivationOptions, ArchiveRelocationActivationHook, ArchiveRelocationState } from "./archive-relocation-contracts";
import path from "node:path";
import fs from "node:fs";
import { locationContains } from "../config/archive-location";
import { readLocalArchiveSelection, proveLocalArchiveActivation, activateLocalArchiveSelection, LocalArchiveActivationDecisionError } from "../config/archive-locator";
import { persistArchiveRelocationLink } from "../config/archive-relocation-link";
import type { LocalArchiveActivationProof, LocalArchiveSelection } from "../config/archive-locator";
import type { ArchiveWriterFence } from "./archive-writers";
import { acquireArchiveWriterFence, ArchiveWritesPausedError } from "./archive-writers";
import { jobPath, validateState, readJson, writeState } from "./archive-relocation-state";
import { acquireJobLock, releaseJobLock } from "./archive-relocation-lock";
import { externalStateDirectory, samePath, syncDirectory } from "./archive-relocation-paths";
import { assertActivationEnvironment, assertActivationPathOverrides, selectionMatches, acquireDatabaseAdmission } from "./archive-relocation-admission";
import type { DatabaseAdmission } from "./archive-relocation-admission";
import { OWNER_FILE, ensureOwnedTarget, claimOwnerExclusively, ownerPayload } from "./archive-relocation-target";
import { finalCopyAndVerify } from "./archive-relocation-transfer";
import { currentProcessProof } from "./archive-relocation-process-proof";

async function notify(options: ArchiveRelocationActivationOptions, phase: ArchiveRelocationActivationHook): Promise<void> {
  await options.hooks?.onPhase?.(phase);
}

/**
 * Explicit local-filesystem cutover. The locator publication is the durable point
 * of decision. Unknown decision outcomes retain both fences; they never reopen the
 * old root. This does not claim exclusion of cloud or remote processes which ignore
 * the shared writer records. Existing processes pinned to old module constants must
 * restart; their old-root writes remain permanently rejected while reads stay intact.
 */
export async function activateArchiveRelocation(
  jobId: string,
  options: ArchiveRelocationActivationOptions,
): Promise<ArchiveRelocationState> {
  const env = options.env ?? process.env;
  const stateFile = jobPath(path.resolve(options.stateDirectory), jobId);
  const lockFile = `${stateFile}.lock`;
  const lock = acquireJobLock(lockFile);
  try {
    const state = validateState(readJson(stateFile));
    if (state.jobId !== jobId) throw new Error("Corrupt archive relocation state: job ID does not match its filename");
    externalStateDirectory(options.stateDirectory, state.sourceRoot, state.destinationRoot);
    assertActivationEnvironment(state.destinationRoot, env);
    assertActivationPathOverrides(state.sourceRoot, state.destinationRoot, env);
    const database = fs.realpathSync(path.resolve(options.database));
    if (locationContains(state.sourceRoot, database) || locationContains(state.destinationRoot, database)) {
      throw new Error("The active database must stay outside both relocation archive roots");
    }

    // These are refusal-only preconditions. Nothing below this branch has been
    // acquired or changed, so a rejected call cannot rewrite durable job state.
    if (state.phase === "activated") {
      const selected = readLocalArchiveSelection(env);
      if (!selectionMatches(selected, state.destinationRoot, state.archiveId)) {
        throw new Error("Activated relocation no longer matches the durable local locator");
      }
      persistArchiveRelocationLink({schema:1,jobId:state.jobId,archiveId:state.archiveId,root:state.destinationRoot,
        stateDirectory:path.resolve(options.stateDirectory)},state.sourceRoot,env);
      return state;
    }
    if (state.phase !== "ready-to-switch" && state.phase !== "activating") {
      throw new Error("Archive relocation must finish copying and verification before activation");
    }

    let proof: LocalArchiveActivationProof;
    let prior: LocalArchiveSelection | null;
    if (state.phase === "ready-to-switch") {
      const selected = readLocalArchiveSelection(env);
      if (selectionMatches(selected, state.destinationRoot, state.archiveId)) {
        throw new Error("Destination locator exists without durable activation evidence");
      }
      if (selected && !selectionMatches(selected, state.sourceRoot, state.archiveId)) {
        throw new Error("Local archive locator belongs to an unrelated archive or location");
      }
      prior = selected;
      proof = { decision: "uncommitted" };
    } else {
      if (!state.activation) throw new Error("Activating relocation lacks durable activation evidence");
      prior = state.activation.priorLocator;
      proof = (options.hooks?.proveDecision ?? proveLocalArchiveActivation)(
        { root: state.destinationRoot, archiveId: state.archiveId }, prior, env,
      );
      if (proof.decision === "unknown") {
        throw new Error(`Archive locator decision is not provable; writer guards remain closed${proof.reason ? `: ${proof.reason}` : ""}`);
      }
    }

    let decision: "uncommitted" | "committed" | "unknown" = proof.decision;
    let admission: DatabaseAdmission | null = null;
    let sourceFence: ArchiveWriterFence | null = null;
    let destinationFence: ArchiveWriterFence | null = null;
    let sourceCommitted = state.activation?.phase === "source-fenced";
    let stateChanged = false;
    let ownsUnsealedDestination = state.activation?.phase === "destination-unsealed";
    try {
      if (decision === "uncommitted") admission = acquireDatabaseAdmission(database, state.archiveId);
      try {
        sourceFence = acquireArchiveWriterFence(state.sourceRoot, state.jobId);
      } catch (error) {
        if (error instanceof ArchiveWritesPausedError && error.jobId === state.jobId && error.destination &&
            samePath(error.destination, state.destinationRoot)) sourceCommitted = true;
        else throw error;
      }
      destinationFence = acquireArchiveWriterFence(state.destinationRoot, state.jobId);
      sourceFence?.assertDrained();
      destinationFence.assertDrained();
      await notify(options, "writers-drained");

      const marker = path.join(state.destinationRoot, OWNER_FILE);
      if (decision === "uncommitted") {
        if (!state.activation) {
          // A missing marker here has no durable final-verification proof. Refuse
          // without promoting the job or recreating externally removed evidence.
          if (!fs.existsSync(marker)) throw new Error("Relocation destination marker is missing before final fenced verification");
          ensureOwnedTarget(state);
          state.activation = {
            phase: "fencing",
            priorLocator: prior,
            contract: "local-shared-filesystem-writers-only",
            remoteProcessExclusion: "not-proven",
            startedAt: new Date().toISOString(),
          };
          state.phase = "activating";
          stateChanged = true;
          writeState(stateFile, state);
        }
        // A recovered guard may follow a released guard. Recheck the bytes under
        // the current fences rather than treating an old phase as continuity proof.
        if (!fs.existsSync(marker)) {
          if (!["final-verified", "destination-unsealed"].includes(state.activation.phase)) {
            throw new Error("Relocation destination marker vanished before final verification was proven");
          }
          claimOwnerExclusively(marker, ownerPayload(state));
          syncDirectory(state.destinationRoot);
        } else ensureOwnedTarget(state);
        state.activation.phase = "fencing";
        stateChanged = true;
        writeState(stateFile, state);
        await finalCopyAndVerify(state, stateFile, destinationFence);
        state.activation.phase = "final-verified";
        writeState(stateFile, state);
        fs.unlinkSync(marker);
        ownsUnsealedDestination = true;
        syncDirectory(state.destinationRoot);
        state.activation.phase = "destination-unsealed";
        writeState(stateFile, state);
        await notify(options, "destination-marker-removed");
        persistArchiveRelocationLink({schema:1,jobId:state.jobId,archiveId:state.archiveId,root:state.destinationRoot,
          stateDirectory:path.resolve(options.stateDirectory)},state.sourceRoot,env);
        try {
          activateLocalArchiveSelection(
            { root: state.destinationRoot, archiveId: state.archiveId },
            state.activation.priorLocator,
            env,
            options.hooks?.afterLocatorCommit,
          );
          decision = "committed";
        } catch (error) {
          decision = error instanceof LocalArchiveActivationDecisionError ? error.decision : "unknown";
          if (decision === "unknown") {
            try {
              decision = (options.hooks?.proveDecision ?? proveLocalArchiveActivation)(
                { root: state.destinationRoot, archiveId: state.archiveId }, state.activation.priorLocator, env,
              ).decision;
            } catch {
              decision = "unknown";
            }
          }
          throw error;
        }
        state.activation.phase = "locator-committed";
        state.activation.decisionAt ??= new Date().toISOString();
        stateChanged = true;
        writeState(stateFile, state);
        await notify(options, "locator-committed");
      } else {
        if (!state.activation || fs.existsSync(marker)) throw new Error("Committed destination has inconsistent activation evidence");
        persistArchiveRelocationLink({schema:1,jobId:state.jobId,archiveId:state.archiveId,root:state.destinationRoot,
          stateDirectory:path.resolve(options.stateDirectory)},state.sourceRoot,env);
        state.activation.phase = sourceCommitted ? "source-fenced" : "locator-committed";
        state.activation.decisionAt ??= new Date().toISOString();
        stateChanged = true;
        writeState(stateFile, state);
      }

      if (!sourceCommitted) {
        if (!sourceFence) throw new Error("Relocation source fence disappeared before permanent cutover");
        sourceFence.markRelocated(state.destinationRoot);
        sourceFence = null;
        sourceCommitted = true;
        state.activation!.phase = "source-fenced";
        stateChanged = true;
        writeState(stateFile, state);
      }
      await notify(options, "source-relocated");

      destinationFence.release();
      destinationFence = null;
      state.activation!.phase = "complete";
      state.activation!.completedAt = new Date().toISOString();
      state.activation!.provenance = currentProcessProof(state.destinationRoot);
      state.phase = "activated";
      delete state.lastError;
      writeState(stateFile, state);
      admission?.commit();
      admission = null;
      return state;
    } catch (error) {
      try { admission?.rollback(); } catch { /* retain the activation failure and guards */ }
      admission = null;
      if (decision === "unknown") {
        // The locator may already name the destination. Never release either
        // guard or recreate the marker until a later process obtains exact proof.
        if (state.activation) {
          state.phase = "activating";
          state.lastError = error instanceof Error ? error.message : String(error);
          try { writeState(stateFile, state); } catch { /* preserve original uncertainty */ }
        }
        throw error;
      }
      if (decision === "committed") {
        if (state.activation) {
          state.phase = "activating";
          state.activation.phase = sourceCommitted ? "source-fenced" : "locator-committed";
          state.activation.decisionAt ??= new Date().toISOString();
          state.lastError = error instanceof Error ? error.message : String(error);
          try { writeState(stateFile, state); } catch { /* locator remains the decision proof */ }
        }
        throw error;
      }

      // Known-uncommitted rollback applies only to this job's acquired guard and
      // mutations. Pure precondition failures never enter this block with changes.
      if (stateChanged && ownsUnsealedDestination) {
        try {
          const marker = path.join(state.destinationRoot, OWNER_FILE);
          if (!fs.existsSync(marker)) {
            claimOwnerExclusively(marker, ownerPayload(state));
            syncDirectory(state.destinationRoot);
          }
          state.phase = state.readyAt && state.entries.every(entry => entry.status === "verified")
            ? "ready-to-switch" : "copying";
          delete state.activation;
          state.lastError = error instanceof Error ? error.message : String(error);
          writeState(stateFile, state);
        } catch {
          // An unprovable destination remains fenced; do not reopen either side.
          throw error;
        }
      } else if (stateChanged) {
        state.lastError = error instanceof Error ? error.message : String(error);
        try { writeState(stateFile, state); } catch { /* preserve original failure */ }
      }
      try { destinationFence?.release(); destinationFence = null; } catch { /* uncertain guard remains closed */ }
      try { sourceFence?.release(); sourceFence = null; } catch { /* uncertain guard remains closed */ }
      throw error;
    }
  } finally {
    releaseJobLock(lock, lockFile);
  }
}

/** Unsafe callers cannot bypass the explicit fenced activation protocol. */
export function assertArchiveRelocationSwitchAllowed(_state: ArchiveRelocationState): never {
  throw new Error("Use explicit archive relocation activation with the prepared local database and all-writer fencing");
}
