import { expect, test } from "bun:test";
import type { SyncRunResult } from "../sync/contracts";
import { startBootstrapCatchUp, type BootstrapSyncPhase } from "./bootstrap-catch-up";

function run(status: SyncRunResult["status"], inputsComplete = true): SyncRunResult {
  return { status, vendors: [{ vendor: "claude", status: "success", inputsComplete }] } as SyncRunResult;
}

test("fresh bootstrap collects originals before archive-only import and requires both complete receipts", async () => {
  const phases: BootstrapSyncPhase[] = [];
  const result = await startBootstrapCatchUp("full", "database-b", phase => {
    phases.push(phase);
    return Promise.resolve(phases.length === 1 ? run("partial_success", false) : run("success"));
  });
  expect(phases).toEqual([
    { mode: "incremental", collection: "mirror-only" },
    { mode: "incremental", collection: "archive" },
  ]);
  expect(result?.complete).toBe(false);
  expect(result?.import?.status).toBe("success");
});

test("archive import may publish partial facts but cannot complete bootstrap", async () => {
  const result = await startBootstrapCatchUp("full", "database-b", phase =>
    Promise.resolve(phase.collection === "mirror-only" ? run("success") : run("success", false)));
  expect(result?.complete).toBe(false);
  expect((await startBootstrapCatchUp("full", "database-b", () => Promise.resolve(run("success"))))?.complete).toBe(true);
});

test("snapshot catch-up stays incremental and a missing recovery identity cannot launch a full collector", async () => {
  const phases: BootstrapSyncPhase[] = [];
  const start = (phase: BootstrapSyncPhase) => { phases.push(phase); return Promise.resolve(run("success")); };
  expect(startBootstrapCatchUp("full", null, start)).toBeNull();
  expect(phases).toEqual([]);
  expect((await startBootstrapCatchUp("incremental", null, start))?.complete).toBe(true);
  expect(phases).toEqual([{ mode: "incremental" }]);
});

test("a busy sync defers bootstrap without accepting the unrelated run as collection proof", () => {
  const phases:BootstrapSyncPhase[]=[];
  const started=startBootstrapCatchUp("full","database-b",phase=>{phases.push(phase);return null;});
  expect(started).toBeNull();
  expect(phases).toEqual([{mode:"incremental",collection:"mirror-only"}]);
});
