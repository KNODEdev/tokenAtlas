import fs from "node:fs";
import { missing } from "./archive-relocation-paths";
import { UUID, MACHINE_UUID } from "./archive-relocation-contracts";
import { readLocalMachineId } from "../config/local-identity";
import { randomUUID } from "node:crypto";
import os from "node:os";

const MAX_LOCK_RECOVERY_STEPS = 1000;

interface JobLockRecord {
  schema: 1;
  token: string;
  host: string;
  pid: number;
  machineId?: string;
}

/** Tokens of the immutable chain this run published or provably superseded, oldest first. */
interface JobLockHandle {
  tokens: string[];
}

function lockSuccessorFile(file: string, token: string): string {
  return `${file}.resume-${token}.json`;
}

function readLockRecord(file: string): JobLockRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let value: JobLockRecord | null = null;
  try { value = JSON.parse(text) as JobLockRecord; } catch { value = null; }
  if (!value || value.schema !== 1 || !UUID.test(value.token) || typeof value.host !== "string" || !value.host ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      (value.machineId !== undefined && (typeof value.machineId !== "string" || !MACHINE_UUID.test(value.machineId)))) {
    throw new Error(`Unrecognized relocation job lock; resolve it manually: ${file}`);
  }
  return value;
}

/**
 * Only a process of this durable machine instance that no longer exists may be superseded.
 * A hostname does not prove local ownership once the state directory is synchronized or
 * restored, so legacy records without a machine instance and foreign owners always stay.
 */
function deadLockOwner(record: JobLockRecord, localMachineId: string | null): boolean {
  if (!localMachineId || !record.machineId || record.machineId !== localMachineId) return false;
  try { process.kill(record.pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

/** The public name appears only as a complete, flushed record, or not at all. */
function publishLockExclusively(file: string, record: JobLockRecord): void {
  const candidate = `${file}.${record.token}.claim`;
  const descriptor = fs.openSync(candidate, "wx");
  let published = false;
  try {
    try {
      fs.writeFileSync(descriptor, JSON.stringify(record));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.linkSync(candidate, file);
    published = true;
  } finally {
    // A sharing violation while removing the private link must not orphan a live public owner.
    try { fs.unlinkSync(candidate); } catch (error) { if (!published && !missing(error)) throw error; }
  }
}

export function assertCurrentJobLock(file: string, lock: JobLockHandle): void {
  let target = file;
  for (const token of lock.tokens) {
    if (readLockRecord(target)?.token !== token) throw new Error(`Relocation job lock ownership changed: ${file}`);
    target = lockSuccessorFile(file, token);
  }
  if (readLockRecord(target)) throw new Error(`Relocation job lock ownership changed: ${file}`);
}

/**
 * Mutual exclusion between local processes working on one relocation job; it is not a
 * distributed lock and assumes the caller-owned state directory is a local filesystem
 * with exclusive create and link. A live, foreign, legacy or unreadable owner is never
 * reclaimed automatically; such a lock has to be resolved by an explicit human decision.
 */
export function acquireJobLock(file: string): JobLockHandle {
  const localMachineId = readLocalMachineId();
  const tokens: string[] = [];
  let target = file;
  let head = readLockRecord(target);
  while (head) {
    if (tokens.includes(head.token) || tokens.length >= MAX_LOCK_RECOVERY_STEPS) {
      throw new Error(`Unrecognized relocation job lock; resolve it manually: ${file}`);
    }
    if (!deadLockOwner(head, localMachineId)) {
      throw new Error(`Relocation job is locked by ${head.host}/${head.pid}: ${file}`);
    }
    tokens.push(head.token);
    target = lockSuccessorFile(file, head.token);
    const successor = readLockRecord(target);
    if (!successor) {
      // Never delete a dead owner and republish its name: competing resumes could then
      // erase each other's live lock. Exactly one successor link can ever be created.
      break;
    }
    head = successor;
  }
  const record: JobLockRecord = {
    schema: 1,
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    ...(localMachineId ? { machineId: localMachineId } : {}),
  };
  try {
    publishLockExclusively(target, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Relocation job lock was taken by a competing recovery: ${file}`);
    }
    throw error;
  }
  tokens.push(record.token);
  const lock = { tokens };
  // A delayed contender can link an obsolete successor after the winner released
  // its chain and a fresh owner acquired the root. That orphan grants no admission.
  assertCurrentJobLock(file, lock);
  return lock;
}

/**
 * Remove only the records this run published or superseded, oldest first, so a freed
 * name can never be re-linked while a later name still points at this run. Unrelated
 * leftovers are left alone: such a name may be a competitor's live successor.
 */
export function releaseJobLock(lock: JobLockHandle, file: string): void {
  assertCurrentJobLock(file, lock);
  lock.tokens.forEach((token, index) => {
    const target = index === 0 ? file : lockSuccessorFile(file, lock.tokens[index - 1]!);
    let current: JobLockRecord | null;
    // A replaced or unreadable record belongs to somebody else; leave it in place.
    try { current = readLockRecord(target); } catch { return; }
    if (!current || current.token !== token) return;
    try { fs.unlinkSync(target); } catch (error) { if (!missing(error)) throw error; }
  });
}
