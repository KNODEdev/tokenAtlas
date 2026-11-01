import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveImportPaused } from "../sync/import-pause";
import { startSyncCompletion } from "./server-sync";

const previous = process.env.TOKENATLAS_LOCAL_STATE;
const roots: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.TOKENATLAS_LOCAL_STATE; else process.env.TOKENATLAS_LOCAL_STATE = previous;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// TALK-001 D12 (REQ-064 AC2/AC5): while paused no source pass starts, an analysis rebuild's included.
test("a paused import starts neither an ordinary run nor a rebuild's source pass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-pause-gate-"));
  roots.push(root);
  process.env.TOKENATLAS_LOCAL_STATE = root;
  saveImportPaused(true, root);
  let started = 0;
  const ctx = { syncRunner: async () => { started++; throw new Error("must not run"); } } as never;
  expect(startSyncCompletion(root, "manual", "incremental", ctx)).toBeNull();
  expect(startSyncCompletion(root, "manual", "incremental", ctx, undefined, {}, 7, "archive")).toBeNull();
  expect(started).toBe(0);
});
