import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { WriteLease, writeLeaseHolder } from "./write-lease";
import { removeTestFixture } from "../test-cleanup";

function fixture(run: (open: () => Database, clock: { now: number }) => void | Promise<void>) {
  return async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-write-lease-"));
    const file = path.join(directory, "atlas.sqlite"), opened: Database[] = [];
    const clock = { now: 1_800_000_000_000 };
    const open = () => { const db = new Database(file); db.exec("PRAGMA journal_mode=WAL"); opened.push(db); return db; };
    try { await run(open, clock); }
    finally { for (const db of opened) db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
  };
}

test("one holder at a time; a waiting party is handed the lease at the holder's next batch boundary", fixture((open, clock) => {
  const now = () => clock.now;
  const worker = new WriteLease(open(), "background", now), sync = new WriteLease(open(), "sync", now);
  expect(worker.tryAcquire()).toBe(true);
  expect(writeLeaseHolder(open(), clock.now)).toMatchObject({ kind: "background", owner: worker.owner });
  expect(worker.mayContinue()).toBe(true);
  // The sync process asks; the worker keeps its minimum slice, then sees the request before its
  // next batch and gives the lease back.
  expect(sync.tryAcquire()).toBe(false);
  expect(worker.mayContinue()).toBe(true);
  clock.now += 1_000;
  expect(worker.mayContinue()).toBe(false);
  worker.release();
  // The worker cannot take it back while the request stands; the requester gets it.
  expect(worker.tryAcquire()).toBe(false);
  expect(sync.tryAcquire()).toBe(true);
  expect(worker.mayContinue()).toBe(false);
  // Now the worker asks, and the sync process sees that at its own boundary after its slice.
  expect(worker.tryAcquire()).toBe(false);
  clock.now += 1_000;
  expect(sync.mayContinue()).toBe(false);
  sync.release();
  expect(worker.tryAcquire()).toBe(true);
}));

test("a request lapses when its party stops asking", fixture((open, clock) => {
  const now = () => clock.now;
  const worker = new WriteLease(open(), "background", now), sync = new WriteLease(open(), "sync", now);
  expect(worker.tryAcquire()).toBe(true);
  expect(sync.tryAcquire()).toBe(false);
  worker.release();
  clock.now += 6_000;
  expect(worker.tryAcquire()).toBe(true);
}));

test("a stale lease is taken: holder process gone, holder restarted in this process, or not renewed in time", fixture((open, clock) => {
  const now = () => clock.now, db = open();
  const remap = new WriteLease(db, "remap", now);
  expect(remap.tryAcquire()).toBe(true);
  // A holder whose process is gone.
  db.exec("UPDATE write_lease SET pid=2147483646");
  expect(new WriteLease(open(), "sync", now).tryAcquire()).toBe(true);
  // A background worker thread that crashed holding it: its successor in the same process takes over.
  const crashed = new WriteLease(open(), "background", now);
  open().exec("UPDATE write_lease SET kind=NULL,owner=NULL,pid=NULL,expires_at=NULL");
  expect(crashed.tryAcquire()).toBe(true);
  const successor = new WriteLease(open(), "background", now);
  expect(successor.tryAcquire()).toBe(true);
  expect(crashed.mayContinue()).toBe(false);
  // A holder that stopped renewing; renewal by checking keeps it alive.
  const sync = new WriteLease(open(), "sync", now);
  expect(sync.tryAcquire()).toBe(false);
  successor.release();
  expect(sync.tryAcquire()).toBe(true);
  clock.now += 10 * 60_000;
  expect(sync.mayContinue()).toBe(true);
  clock.now += 10 * 60_000;
  expect(new WriteLease(open(), "background", now).tryAcquire()).toBe(false);
  clock.now += 6 * 60_000;
  expect(writeLeaseHolder(open(), clock.now)).toBeNull();
  expect(new WriteLease(open(), "remap", now).tryAcquire()).toBe(true);
}));

test("acquire waits until the holder releases", fixture(async (open) => {
  const worker = new WriteLease(open(), "background"), sync = new WriteLease(open(), "sync");
  expect(worker.tryAcquire()).toBe(true);
  let polls = 0;
  const acquired = sync.acquire({ pollMs: 1, wait: async () => { polls++; if (polls === 3) worker.release(); } });
  expect(await acquired).toBe(true);
  expect(polls).toBe(3);
  expect(await new WriteLease(open(), "remap").acquire({ stop: () => true })).toBe(false);
}));

test("a holder's long transaction makes taking the lease a plain refusal, not an error", fixture((open) => {
  const holder = open(), waiting = open();
  // The shared busy timeout is seconds; this connection gives up at once to keep the test short.
  waiting.exec("PRAGMA busy_timeout=20");
  holder.exec("CREATE TABLE facts(n INTEGER); BEGIN IMMEDIATE; INSERT INTO facts VALUES(1)");
  try { expect(new WriteLease(waiting, "background").tryAcquire()).toBe(false); }
  finally { holder.exec("COMMIT"); }
  expect(new WriteLease(waiting, "background").tryAcquire()).toBe(true);
}));
