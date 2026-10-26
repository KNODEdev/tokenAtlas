import { expect, test } from "bun:test";
import { processAlive, readProcessBirth, syncOwnerAlive } from "./process-owner";

const startedAt = "2026-10-15T01:00:00.000Z";
const birth = { identity: "process-instance-a", startedAt: Date.parse(startedAt) - 1000 };
const owner = { ownerPid: 123, ownerProcessStart: birth.identity, startedAt };
const alive = () => true;

test("the same process birth remains the owner even when the wall clock moved", () => {
  expect(syncOwnerAlive({ ...owner, startedAt: "2020-01-01T00:00:00Z" }, () => birth, alive)).toBe(true);
});

test("a reused live PID cannot keep another process's run active", () => {
  expect(syncOwnerAlive(owner, () => ({ ...birth, identity: "process-instance-b" }), alive)).toBe(false);
});

test("a legacy run is recovered when its live PID was born after the run started", () => {
  expect(syncOwnerAlive({ ownerPid: 123, startedAt }, () => ({ ...birth, startedAt: Date.parse(startedAt) + 1 }), alive)).toBe(false);
});

test("a legacy run with a matching lifetime keeps its live writer", () => {
  expect(syncOwnerAlive({ ownerPid: 123, startedAt }, () => birth, alive)).toBe(true);
});

test("an unreadable process birth never authorizes replacing a live writer", () => {
  expect(syncOwnerAlive(owner, () => undefined, alive)).toBe(true);
});

test("a process that exits during its birth lookup is recoverable", () => {
  let checks = 0;
  expect(syncOwnerAlive(owner, () => undefined, () => ++checks === 1)).toBe(false);
});

test("a dead or absent owner is recoverable without querying its birth", () => {
  const unexpected = () => { throw new Error("dead owners need no birth lookup"); };
  expect(syncOwnerAlive(owner, unexpected, () => false)).toBe(false);
  for (const ownerPid of [undefined, 0, -1, NaN, 1.5]) {
    expect(syncOwnerAlive({ ownerPid, startedAt }, unexpected, unexpected)).toBe(false);
  }
});

test("an invalid legacy timestamp preserves an otherwise live owner", () => {
  expect(syncOwnerAlive({ ownerPid: 123, startedAt: "unknown" }, () => birth, alive)).toBe(true);
});

test("the actual OS process birth is stable and identifies this live process", () => {
  const own = readProcessBirth(process.pid);
  expect(own).toBeDefined();
  expect(own!.startedAt).toBeLessThanOrEqual(Date.now());
  expect(readProcessBirth(process.pid)).toEqual(own);
  expect(processAlive(process.pid)).toBe(true);
  expect(syncOwnerAlive({ ownerPid: process.pid, ownerProcessStart: own!.identity, startedAt })).toBe(true);
  expect(syncOwnerAlive({ ownerPid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" })).toBe(false);
});
