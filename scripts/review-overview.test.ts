import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { measureOverviewRead, parseOverviewArgs } from "./review-overview";
const dirs: string[] = [];
function createFixture(file: string, historical = true): void {
  const sqlite = new Database(file, { create: true });
  try {
    applyDrizzleMigrations(drizzle(sqlite));
    // This diagnostic benchmarks frozen pre-W9 SQL, not the current account reader.
    if (historical) sqlite.exec("ALTER TABLE probe_windows ADD COLUMN era_unattributed INTEGER NOT NULL DEFAULT 0");
    sqlite.transaction(() => {
      const insert = sqlite.query(`INSERT INTO probe_windows
        (provider, subject, ts, kind, limit_group, reported_percent_side, used_percent, ok, machine, window_minutes)
        VALUES ('codex', ?, ?, 'secondary', 'codex', 'used', ?, 1, ?, 10080)`);
      const end = Date.parse("2026-09-06T09:00:00.000Z");
      for (let subject = 0; subject < 2; subject++) for (let sample = 0; sample < 20; sample++)
        insert.run(`synthetic-${subject}`, new Date(end - sample * 60_000).toISOString(), sample % 99,
          subject % 2 ? "PC-B" : "PC-A");
    })();
  } finally {
    Bun.gc(true);
    (sqlite as Database & { clearQueryCache(): void }).clearQueryCache();
    sqlite.close(true);
  }
}
function fixture(historical = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-overview-review-')); dirs.push(dir);
  const file = path.join(dir, 'copy.sqlite'); createFixture(file, historical); Bun.gc(true);
  return { dir, file };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
test('read-only copied DB report verifies parity and saves no identifying fields', () => {
  const { file } = fixture();
  const db = new Database(file); db.exec("UPDATE probe_windows SET subject='private@example.test', machine='SECRET-PC' WHERE subject='synthetic-0'"); db.close(true);
  const before = fs.readFileSync(file); const report = measureOverviewRead(file, 2);
  expect(report.status).toBe('measured');
  expect(report).toMatchObject({ parity: true, main_writes: false, result_rows: 2, codex_probe_rows: 40,
    oracle: { status: 'pass', attributed_predicate_matches: true, reference_sql_matches: true } });
  expect(JSON.stringify(report)).not.toContain('private@example.test');
  expect(JSON.stringify(report)).not.toContain('SECRET-PC'); expect(JSON.stringify(report)).not.toContain(file);
  expect(fs.readFileSync(file)).toEqual(before);
});
test('missing and incompatible databases yield blocked reports and are not created or repaired', () => {
  const { dir, file } = fixture(); const missing = path.join(dir, 'missing.sqlite');
  expect(measureOverviewRead(missing, 2).status).toBe('blocked'); expect(fs.existsSync(missing)).toBe(false);
  const db = new Database(file); db.exec("UPDATE __drizzle_migrations SET hash='different'"); db.close(true);
  const before = fs.readFileSync(file); expect(measureOverviewRead(file, 2).status).toBe('blocked');
  expect(fs.readFileSync(file)).toEqual(before);
});
test('CLI arguments require explicit copy, new JSON report and a non-identifying machine label', () => {
  const valid = ['--db-copy','copy.sqlite','--out','report.json','--machine','MAIN'];
  expect(parseOverviewArgs(valid)).toMatchObject({ samples: 20, processRuns: 5, label: 'MAIN' });
  for (const args of [[], [...valid,'--samples','19'], [...valid,'--samples','201'], [...valid,'--process-runs','4'],
    [...valid,'--out','another.json'],
    ['--db-copy','x.json','--out','x.json','--machine','MAIN'],
    ['--db-copy','x.sqlite','--out','report.json','--machine','real-user'], [...valid,'--unknown','x']])
    expect(() => parseOverviewArgs(args)).toThrow();
});
test('CLI writes one explicit report and refuses to overwrite any existing file', async () => {
  const { dir, file } = fixture(); const output = path.join(dir, 'report.json'); const before = fs.readFileSync(file);
  async function run(args: string[]) {
    const p = Bun.spawn([process.execPath, path.join(import.meta.dir,'review-overview.ts'), ...args], {stdout:'pipe',stderr:'pipe',
      env: {...process.env, TOKENATLAS_DB: file, TOKENATLAS_ARCHIVE: path.join(dir,'must-not-exist')}});
    const out = new Response(p.stdout).text(), err = new Response(p.stderr).text();
    const exit = await p.exited; await out; await err; return exit;
  }
  expect(await run([])).toBe(2);
  const args=['--db-copy',file,'--out',output,'--machine','LAPTOP','--samples','20','--process-runs','5'];
  expect(await run(args)).toBe(0);
  const report = JSON.parse(fs.readFileSync(output,'utf8'));
  expect(report).toMatchObject({ status:'measured', machine_label:'LAPTOP', immutable_input: true,
    timing: { process: { required_runs: 5, completed_runs: 5 }, route: null, context: null, browser: null } });
  expect(report.timing.process.runs.map((row: { starting_order: string }) => row.starting_order)).toEqual([
    'reference-then-candidate', 'candidate-then-reference', 'reference-then-candidate',
    'candidate-then-reference', 'reference-then-candidate',
  ]);
  const saved=fs.readFileSync(output); expect(await run(args)).toBe(2); expect(fs.readFileSync(output)).toEqual(saved);
  expect(fs.readFileSync(file)).toEqual(before); expect(fs.existsSync(path.join(dir,'must-not-exist'))).toBe(false);
});


test("retired historical SQL is explicitly unavailable on W9 without changing the database", () => {
  const { file } = fixture(false), before = fs.readFileSync(file);
  expect(measureOverviewRead(file, 2)).toMatchObject({status:"blocked",reason:"historical-query-schema-retired"});
  expect(fs.readFileSync(file)).toEqual(before);
});
