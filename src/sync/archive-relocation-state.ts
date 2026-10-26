import path from "node:path";
import { UUID } from "./archive-relocation-contracts";
import fs from "node:fs";
import type { ArchiveRelocationState } from "./archive-relocation-contracts";
import { samePath, safeRelative } from "./archive-relocation-paths";
import { validProcessProof } from "./archive-relocation-process-proof";
import { atomicArchiveWrite } from "./archive-publication";

export const STATE_SCHEMA = 1 as const;

export function jobPath(stateDirectory: string, jobId: string): string {
  if (!UUID.test(jobId)) throw new Error("Invalid relocation job ID");
  return path.join(stateDirectory, `${jobId}.json`);
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function validateState(value: unknown): ArchiveRelocationState {
  try {
    const state = value as ArchiveRelocationState;
    if (!state || state.schema !== STATE_SCHEMA || !UUID.test(state.jobId) ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(state.archiveId) ||
        typeof state.sourceRoot !== "string" || !path.isAbsolute(state.sourceRoot) ||
        typeof state.destinationRoot !== "string" || !path.isAbsolute(state.destinationRoot) ||
        samePath(state.sourceRoot, state.destinationRoot) ||
        !["copying", "verifying", "ready-to-switch", "activating", "activated"].includes(state.phase) ||
        !Array.isArray(state.entries) || !Array.isArray(state.directories) ||
        typeof state.createdAt !== "string" || !Number.isFinite(Date.parse(state.createdAt)) ||
        typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt)) ||
        (state.readyAt !== undefined && (typeof state.readyAt !== "string" || !Number.isFinite(Date.parse(state.readyAt)))) ||
        (state.lastError !== undefined && typeof state.lastError !== "string")) {
      throw new Error("invalid root, identity, phase, or timestamp fields");
    }
    const directories = new Set<string>();
    for (const directory of state.directories) {
      safeRelative(directory);
      const key = process.platform === "win32" ? directory.toLowerCase() : directory;
      if (directories.has(key)) throw new Error(`duplicate directory '${directory}'`);
      directories.add(key);
    }
    const paths = new Set<string>();
    for (const entry of state.entries) {
      safeRelative(entry.relative);
      const key = process.platform === "win32" ? entry.relative.toLowerCase() : entry.relative;
      let parsedStamp: unknown;
      try { parsedStamp = JSON.parse(entry.sourceStamp); } catch { throw new Error(`invalid source stamp for '${entry.relative}'`); }
      const stampParts = parsedStamp as unknown[];
      if (paths.has(key) || !Array.isArray(stampParts) || stampParts.length !== 3 ||
          !stampParts.every(part => typeof part === "number" && Number.isFinite(part) && part >= 0) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || stampParts[0] !== entry.bytes ||
          !Number.isSafeInteger(entry.mode) || entry.mode < 0 ||
          !Number.isFinite(entry.modifiedAtMs) || entry.modifiedAtMs < 0 || stampParts[1] !== entry.modifiedAtMs ||
          !["pending", "copying", "copied", "verified"].includes(entry.status) ||
          (entry.digest !== null && !/^[a-f0-9]{64}$/.test(entry.digest))) {
        throw new Error(`invalid entry '${entry.relative}'`);
      }
      paths.add(key);
    }
    if ((state.phase === "ready-to-switch" || state.phase === "activated") &&
        (!state.readyAt || state.entries.some(entry => entry.status !== "verified"))) {
      throw new Error(`${state.phase} state is not fully verified`);
    }
    if (state.phase === "activating" || state.phase === "activated") {
      const activation = state.activation;
      if (!activation ||
          !["fencing", "final-verified", "destination-unsealed", "locator-committed", "source-fenced", "complete"].includes(activation.phase) ||
          activation.contract !== "local-shared-filesystem-writers-only" ||
          activation.remoteProcessExclusion !== "not-proven" ||
          typeof activation.startedAt !== "string" || !Number.isFinite(Date.parse(activation.startedAt)) ||
          (activation.decisionAt !== undefined && !Number.isFinite(Date.parse(activation.decisionAt))) ||
          (activation.completedAt !== undefined && !Number.isFinite(Date.parse(activation.completedAt))) ||
          (state.phase === "activated" && activation.phase !== "complete")) {
        throw new Error("invalid activation state");
      }
      if (activation.priorLocator !== null &&
          (typeof activation.priorLocator.root !== "string" || !path.isAbsolute(activation.priorLocator.root) ||
           typeof activation.priorLocator.archiveId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(activation.priorLocator.archiveId))) {
        throw new Error("invalid prior locator");
      }
      if(activation.provenance && !validProcessProof(activation.provenance))throw new Error("invalid activation process provenance");
    } else if (state.activation !== undefined) {
      throw new Error("activation evidence exists outside activation phase");
    }
    if(state.postActivation) {
      const receipt=state.postActivation;
      if(state.phase!=="activated"||!state.activation?.provenance||receipt.status!=="verified"
        ||receipt.contract!=="local-filesystem-read-write-check"||!validProcessProof(receipt)
        ||!Number.isFinite(Date.parse(receipt.verifiedAt)))throw new Error("invalid post-activation receipt");
      for(const proof of [receipt.read,receipt.write]) {
        if(!proof||typeof proof.relative!=="string"||!Number.isSafeInteger(proof.bytes)||proof.bytes<0||!/^[a-f0-9]{64}$/.test(proof.digest))
          throw new Error("invalid post-activation IO proof");
        safeRelative(proof.relative);
      }
    }
    return state;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("Corrupt archive relocation state:")) throw error;
    throw new Error(`Corrupt archive relocation state: ${detail}`);
  }
}

export function writeState(file: string, state: ArchiveRelocationState): void {
  state.updatedAt = new Date().toISOString();
  state.entries.sort((a, b) => a.relative.localeCompare(b.relative));
  state.directories.sort();
  atomicArchiveWrite(file, JSON.stringify(state));
}

export function readArchiveRelocation(stateDirectory: string, jobId: string): ArchiveRelocationState {
  const state = validateState(readJson(jobPath(path.resolve(stateDirectory), jobId)));
  if (state.jobId !== jobId) throw new Error("Corrupt archive relocation state: job ID does not match its filename");
  return state;
}
