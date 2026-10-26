import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ingestGaugesAsync } from "../ingest/gauges";
import { SUPERSEDED_JOURNALS_FILE } from "../providers/core/journal-files";
import { removeTestFixture } from "../test-cleanup";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";

const MONTH = "probe_windows.2026-09.jsonl";
const READING = JSON.stringify({ provider: "codex", subject: "fixture-account", ts: "2026-09-01T10:00:00Z",
  kind: "primary", limit_group: "codex", reported_percent_side: "used", used_percent: 20, window_minutes: 300, machine: "fixture-pc" }) + "\n";
const supersession = (into: unknown) => JSON.stringify({ "probe_windows.jsonl": {
  bytes: Buffer.byteLength(READING), sha256: "a".repeat(64), lines: 1, into, superseded_at: "2026-09-21T00:00:00Z" } });

type GaugeOutcome = { status: string; processedInputs: number; inputsComplete: boolean;
  diagnostics: { files: Array<{ file: string }>; reparse?: { unavailable?: unknown[] } } };

/** An accepted journal reading, then whatever `change` does to the store, then a gauge rebuild through the runner. */
async function rebuildAfter(change: (store: string, original: string) => void) {
  const { directory, dbPath } = createTestDatabase();
  const archiveRoot = path.join(directory, "archive"), store = path.join(archiveRoot, "gauges", "fixture-pc");
  fs.mkdirSync(store, { recursive: true });
  const original = path.join(store, "probe_windows.jsonl");
  fs.writeFileSync(original, READING);
  expect((await ingestGaugesAsync({ atlasPath: dbPath, archiveRoot, ownStore: "receiver", force: false })).rows).toBe(1);
  change(store, original);
  const config = path.join(directory, "config");
  fs.mkdirSync(config);
  for (const [name, contents] of Object.entries({ "accounts.json": emptyAccountsDocument(), "projects.json": { projects: [] }, "rate-cards.json": { vendors: {} } }))
    fs.writeFileSync(path.join(config, name), JSON.stringify(contents));
  const request = { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental",
    reparse: {}, rebuildGeneration: 77, collection: "archive" } as const;
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "runner.ts"), JSON.stringify({ dbPath, rootDir: process.cwd(), request })], {
    env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: config, TOKENATLAS_LOCAL_STATE: path.join(directory, "local"),
      USERPROFILE: path.join(directory, "absent-user"), HOME: path.join(directory, "absent-user"),
      APPDATA: path.join(directory, "absent-appdata"), LOCALAPPDATA: path.join(directory, "absent-localappdata") },
    stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .finally(() => clearTimeout(timeout));
  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  const line = out.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
  expect(line).toBeDefined();
  const result = JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length)) as { status: string; error: string | null; vendors: Array<GaugeOutcome & { vendor: string }> };
  const check = new Database(dbPath, { readonly: true });
  try {
    return { directory, original, result, gauges: result.vendors.find(vendor => vendor.vendor === "gauges")!,
      readings: check.query("SELECT ts,used_percent FROM probe_windows").all(),
      bookmarks: check.query("SELECT store,path,size,offset FROM gauge_files ORDER BY path").all() };
  } finally { check.close(); }
}

const accepted = { store: "fixture-pc", path: "probe_windows.jsonl", size: Buffer.byteLength(READING), offset: Buffer.byteLength(READING) };

for (const scenario of ["replacement", "original exists"] as const) {
  test(`a gauge rebuild reads a superseded journal where its readings now live: ${scenario}`, async () => {
    const run = await rebuildAfter((store, original) => {
      // The owner rewrote the journal into a monthly segment; "original exists" names a replacement that was never written.
      if (scenario === "replacement") {
        fs.unlinkSync(original);
        fs.writeFileSync(path.join(store, MONTH), READING);
      }
      fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), supersession([MONTH]));
    });
    try {
      expect({ status: run.result.status, error: run.result.error }).toEqual({ status: "success", error: null });
      expect(run.gauges).toMatchObject({ status: "success", processedInputs: 1, inputsComplete: true });
      // The rebuild read the file that holds the readings now, and nothing else.
      expect(run.gauges.diagnostics.files.map(file => file.file)).toEqual([scenario === "replacement" ? MONTH : "probe_windows.jsonl"]);
      expect(run.readings).toEqual([{ ts: "2026-09-01T10:00:00Z", used_percent: 20 }]);
      // The accepted position of the superseded journal is kept; the segment gains its own.
      expect(run.bookmarks).toEqual(scenario === "replacement" ? [{ ...accepted, path: MONTH }, accepted] : [accepted]);
    } finally {
      Bun.gc(true);
      removeTestFixture(run.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);
}

const vanished: Record<string, (store: string) => void> = {
  "missing record": () => {},
  "invalid JSON": store => fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), "{"),
  "malformed record": store => fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), supersession([])),
  "non-journal": store => {
    fs.writeFileSync(path.join(store, "notes.txt"), READING);
    fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), supersession(["notes.txt"]));
  },
  "other kind": store => {
    fs.writeFileSync(path.join(store, "account_observations.2026-09.jsonl"), "");
    fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), supersession(["account_observations.2026-09.jsonl"]));
  },
  "missing replacement": store => fs.writeFileSync(path.join(store, SUPERSEDED_JOURNALS_FILE), supersession([MONTH])),
};
for (const [scenario, change] of Object.entries(vanished)) test(`a gauge rebuild reports a vanished registered journal as unavailable and keeps its readings: ${scenario}`, async () => {
  const run = await rebuildAfter((store, original) => { fs.unlinkSync(original); change(store); });
  try {
    // The server turns this into the rebuild's "restore access and resume" error; nothing accepted is lost.
    expect(run.gauges).toMatchObject({ status: "success", inputsComplete: false });
    expect(run.gauges.diagnostics.reparse?.unavailable).toEqual([{ store: "fixture-pc", path: run.original }]);
    expect(run.readings).toEqual([{ ts: "2026-09-01T10:00:00Z", used_percent: 20 }]);
    // Its accepted position stays; an unrelated file of another kind is its own journal.
    expect(run.bookmarks).toContainEqual(accepted);
  } finally {
    Bun.gc(true);
    removeTestFixture(run.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 30_000);
