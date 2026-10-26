import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleManualCapacity, readManualCapacity } from "./manual-capacity";
import type { ManualCapacityInput, ManualCapacityStore } from "../shared/manual-capacity";

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) {
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  }
});
const input: ManualCapacityInput = { counter: '["weekly_all","weekly",10080]', start: "2026-08-10T10:00:00.000Z", end: "2026-08-10T12:00:00.000Z",
  start_percent: 20, end_percent: 40, approximate_time: false, note: "Panel dostawcy" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-manual-capacity-")); directories.push(root);
  return { root, request: (body?: unknown, account = "a", provider = "claude") => handleManualCapacity(new Request(`http://localhost/api/manual-capacity?provider=${provider}&account=${account}`,
    body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), root) };
}

test("manual intervals persist, edit without duplication, isolate accounts and require fresh revisions", async () => {
  const { root, request } = fixture();
  const initial = await (await request()).json() as ManualCapacityStore;
  expect(initial).toEqual({ revision: "empty", measurements: [] });
  const saved = await (await request({ revision: initial.revision, measurement: input })).json() as ManualCapacityStore;
  const id = saved.measurements[0]!.id;
  expect(readManualCapacity("claude", root)).toEqual(saved);
  expect((await request({ revision: initial.revision, measurement: input })).status).toBe(409);
  expect((await (await request(undefined, "b")).json()).measurements).toEqual([]);
  expect((await request({ revision: saved.revision, measurement: { ...input, id } }, "b")).status).toBe(404);
  const edited = await (await request({ revision: saved.revision, measurement: { ...input, id, end_percent: 60 } })).json() as ManualCapacityStore;
  expect(edited.measurements).toHaveLength(1);
  expect(edited.measurements[0]!.end_percent).toBe(60);
  expect((await request({ revision: edited.revision, measurement: input })).status).toBe(409);
  const removed = await (await request({ revision: edited.revision, remove: id })).json() as ManualCapacityStore;
  expect(removed.measurements).toEqual([]);
});

test("invalid dates, percentages and unsupported counters never write a measurement", async () => {
  const { request, root } = fixture();
  for (const patch of [
    { start: input.end }, { end: "invalid" }, { start: "2026-02-30T10:00:00.000Z" },
    { start_percent: -1 }, { end_percent: 101 }, { end_percent: 20 }, { start_percent: "20" },
    { end: "2099-01-01T00:00:00.000Z" }, { counter: '["unsupported","weekly",10080]' }, { id: 123 },
  ]) expect((await request({ revision: "empty", measurement: { ...input, ...patch } })).status).toBe(400);
  expect((await request({ revision: "empty", measurement: input }, "all")).status).toBe(400);
  expect(readManualCapacity("claude", root).measurements).toEqual([]);
});
