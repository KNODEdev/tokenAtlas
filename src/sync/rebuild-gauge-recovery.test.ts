import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { createProbeCollection, type CanonicalProbe } from "../db/probe-facts";
import { ingestGaugesAsync } from "../ingest/gauges";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";

test("a whole-archive gauge rebuild restores a missing canonical projection without changing immutable evidence", async () => {
  const { directory, dbPath } = createTestDatabase();
  try {
    const archiveRoot = path.join(directory, "archive");
    const config = path.join(directory, "config");
    const journal = path.join(archiveRoot, "gauges", "fixture-pc", "probe_windows.jsonl");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.mkdirSync(config);

    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify(emptyAccountsDocument()));
    fs.writeFileSync(path.join(config, "projects.json"), JSON.stringify({ projects: [] }));
    fs.writeFileSync(path.join(config, "rate-cards.json"), JSON.stringify({ vendors: {} }));

    const payload = (ts: string, usedPercent: number) => ({
      provider: "codex",
      subject: "codex3",
      ts,
      plan: "plus",
      kind: "primary",
      limit_group: "codex",
      scope: null,
      reported_percent_side: "used",
      used_percent: usedPercent,
      remaining_percent: null,
      vendor_percent: usedPercent,
      window_minutes: 300,
      allowance: null,
      used: null,
      remaining: null,
      resets_at: null,
      rate_limit_reached: 0,
      reset_credits: null,
      profile: null,
      ok: 1,
      error: null,
      extra: JSON.stringify({ home: "C:/Users/fixture/.codex" }),
      machine: "fixture-pc",
      login: "fixture",
      source_home: "C:/Users/fixture/.codex",
      raw_subject: "codex3",
    });
    const canonicalLine = (canonical: CanonicalProbe) => JSON.stringify({
      ...canonical.payload,
      canonical_version: 1,
      canonical_probe: canonical,
      journal_version: 2,
      journal_entry_id: randomUUID(),
    });

    const targetTs = "2026-09-01T10:00:00.000Z";
    const outsideTs = "2026-09-02T10:00:00.000Z";
    const target = createProbeCollection([payload(targetTs, 73)])[0]!;
    const outside = createProbeCollection([payload(outsideTs, 41)])[0]!;
    fs.writeFileSync(journal, `${canonicalLine(target)}\n${canonicalLine(outside)}\n`);

    expect((await ingestGaugesAsync({ atlasPath: dbPath, archiveRoot, ownStore: "receiver", force: false })))
      .toMatchObject({ files: 1, rows: 2, malformed: 0 });

    const snapshot = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return {
          target: db.query("SELECT provider,subject,ts,used_percent FROM probe_windows WHERE ts=?").all(targetTs),
          outside: db.query("SELECT * FROM probe_windows WHERE ts=?").all(outsideTs),
          observations: db.query("SELECT * FROM probe_observations ORDER BY id").all(),
          counters: db.query("SELECT * FROM probe_counters ORDER BY id").all(),
          receipts: db.query("SELECT * FROM gauge_journal_receipts").all(),
          bookmark: db.query("SELECT * FROM gauge_files ORDER BY store,path").all(),
          revision: db.query("SELECT data_revision FROM vendor_sync_revisions WHERE vendor='gauges'").get(),
        };
      } finally {
        db.close(true);
      }
    };

    const accepted = snapshot();
    expect(accepted.target).toEqual([{ provider: "codex", subject: "codex3", ts: targetTs, used_percent: 73 }]);
    expect(accepted.outside).toHaveLength(1);
    expect(accepted.observations).toHaveLength(2);
    expect(accepted.counters).toHaveLength(2);
    expect(accepted.receipts).toHaveLength(2);
    expect(accepted.bookmark).toHaveLength(1);

    const db = new Database(dbPath);
    try {
      db.query("DELETE FROM probe_windows WHERE provider='codex' AND ts=?").run(targetTs);
    } finally {
      db.close(true);
    }

    const damaged = snapshot();
    expect(damaged.target).toEqual([]);
    expect(damaged.outside).toEqual(accepted.outside);
    expect(damaged.observations).toEqual(accepted.observations);
    expect(damaged.counters).toEqual(accepted.counters);
    expect(damaged.receipts).toEqual(accepted.receipts);
    expect(damaged.bookmark).toEqual(accepted.bookmark);

    const request = {
      trigger: "manual",
      scope: { kind: "vendor", vendor: "gauges" },
      mode: "incremental",
      reparse: {},
      rebuildGeneration: 78,
      collection: "archive",
    } as const;
    const rebuild = async (freshGeneration = false, ranged = false) => {
      const selectedRequest = ranged ? {...request,rebuildGeneration:77,reparse:{from:"2026-09-01",until:"2026-09-01"}}
        : freshGeneration ? {...request,rebuildGeneration:79} : request;
      const child = Bun.spawn([
        process.execPath,
        path.join(import.meta.dir, "runner.ts"),
        JSON.stringify({ dbPath, rootDir: process.cwd(), request:selectedRequest }),
      ], {
        env: {
          ...process.env,
          TOKENATLAS_ARCHIVE: archiveRoot,
          TOKENATLAS_CONFIG: config,
          TOKENATLAS_LOCAL_STATE: path.join(directory, "local"),
          USERPROFILE: path.join(directory, "absent-user"),
          HOME: path.join(directory,"absent-user"),
          APPDATA: path.join(directory,"absent-appdata"),
          LOCALAPPDATA: path.join(directory,"absent-localappdata"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 30_000);
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timeout));
      expect({ exit, err }).toEqual({ exit: 0, err: "" });
      const line = out.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length));
      expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
      const vendor = result.vendors.find((item: { vendor: string }) => item.vendor === "gauges");
      expect(vendor).toMatchObject({
        status: "success",
        processedInputs: ranged ? 0 : 1,
      });
      return vendor as { dataChanged: boolean };
    };

    // An unchanged journal is not replayed by a ranged rebuild, even if a projection is missing.
    expect((await rebuild(false,true)).dataChanged).toBe(false);
    expect(snapshot()).toEqual(damaged);
    expect((await rebuild()).dataChanged).toBe(true);
    const restored = snapshot();
    expect(restored.target).toEqual(accepted.target);
    expect(restored.outside).toEqual(accepted.outside);
    expect(restored.observations).toEqual(accepted.observations);
    expect(restored.counters).toEqual(accepted.counters);
    expect(restored.receipts).toEqual(accepted.receipts);
    expect(restored.bookmark).toEqual(accepted.bookmark);

    // Resume preserves the completed outcome; unchanged facts and revision prove that it does no work.
    expect((await rebuild()).dataChanged).toBe(true);
    expect(snapshot()).toEqual(restored);
    expect((await rebuild(true)).dataChanged).toBe(false);
    expect(snapshot()).toEqual(restored);
  } finally {
    Bun.gc(true);
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
