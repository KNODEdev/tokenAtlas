import { afterEach, expect, test } from "bun:test";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { reviewPreflight } from "./review-preflight";

const dirs: string[] = [];
function fixture(migrationIndex?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-review-preflight-")); dirs.push(dir);
  const file = path.join(dir, "copy.sqlite");
  let folder = path.resolve(import.meta.dir, "../drizzle");
  if (migrationIndex != null) {
    const target = path.join(dir, "migrations"); fs.cpSync(folder, target, { recursive: true });
    const journal = path.join(target, "meta/_journal.json");
    const value = JSON.parse(fs.readFileSync(journal, "utf8"));
    value.entries = value.entries.filter((entry: { idx: number }) => entry.idx <= migrationIndex);
    fs.writeFileSync(journal, JSON.stringify(value)); folder = target;
  }
  const db = new Database(file, { create: true });
  try { applyDrizzleMigrations(drizzle(db), folder); } finally { db.close(true); }
  return { dir, file };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("preflight accepts a canonical database without changing any bytes or claiming operator acceptance", () => {
  const { file } = fixture(); const before = fs.readFileSync(file);
  const report = reviewPreflight(file);
  expect(report.status).toBe("compatible");
  expect(report.journal).toEqual({ pending: 0, receipts: 0 });
  expect(report.acceptance).toEqual({ private_golden: "not-run", multi_pc: "not-run", user_review: "not-recorded" });
  expect(fs.readFileSync(file)).toEqual(before);
});
for (const index of [19, 20, 21]) {
  test(`preflight reports canonical 00${index} as upgrade-required and does not run a migration`, () => {
    const { file } = fixture(index); const before = fs.readFileSync(file);
    expect(reviewPreflight(file).status).toBe("upgrade-required");
    expect(fs.readFileSync(file)).toEqual(before);
  });
}
test("preflight refuses edited migration history without repairing it", () => {
  const { file } = fixture(); const db = new Database(file);
  try { db.exec("UPDATE __drizzle_migrations SET hash='altered'"); } finally { db.close(true); }
  const before = fs.readFileSync(file);
  expect(reviewPreflight(file).reason).toBe("migration-history-mismatch");
  expect(fs.readFileSync(file)).toEqual(before);
});
test("preflight refuses untracked, incomplete and non-SQLite input", () => {
  const { file, dir } = fixture(); const db = new Database(file);
  try { db.exec("DROP TABLE gauge_journal_receipts"); } finally { db.close(true); }
  expect(reviewPreflight(file).reason).toBe("incomplete-schema");
  const other = new Database(path.join(dir, "other.sqlite"));
  other.exec("CREATE TABLE unrelated (secret TEXT)"); other.close(true);
  expect(reviewPreflight(path.join(dir, "other.sqlite")).reason).toBe("untracked-schema");
  const text = path.join(dir, "not-sqlite"); fs.writeFileSync(text, "secret@example.test");
  expect(reviewPreflight(text).status).toBe("blocked");
  expect(JSON.stringify(reviewPreflight(text))).not.toContain("secret@example.test");
  const missing = path.join(dir, "missing.sqlite");
  expect(reviewPreflight(missing).reason).toBe("database-missing");
  expect(fs.existsSync(missing)).toBe(false);
});
test("preflight reports queued work without opening its target or disclosing payloads", () => {
  const { file, dir } = fixture(); const target = path.join(dir, "must-not-exist");
  const db = new Database(file);
  try {
    db.query(`INSERT INTO gauge_journal_outbox (entry_id, journal_root, file_name, payload, queued_at)
      VALUES ('entry', ?, 'probe_windows.jsonl', 'secret@example.test', 'not-a-time')`).run(target);
  } finally { db.close(true); }
  const before = fs.readFileSync(file); const report = reviewPreflight(file);
  expect(report.journal?.pending).toBe(1);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(JSON.stringify(report)).not.toContain(target);
  expect(JSON.stringify(report)).not.toContain("secret@example.test");
});
test("CLI requires an explicit copy and ignores the default database environment", async () => {
  const { file, dir } = fixture(); const before = fs.readFileSync(file);
  const command = path.join(import.meta.dir, "review-preflight.ts");
  const env = { ...process.env, TOKENATLAS_DB: file, TOKENATLAS_ARCHIVE: path.join(dir, "archive") };
  const missing = Bun.spawn([process.execPath, command], { env, stdout: "pipe", stderr: "pipe" });
  const missingOut = new Response(missing.stdout).text(); const missingErr = new Response(missing.stderr).text();
  expect(await missing.exited).toBe(2); await missingOut; await missingErr;
  const good = Bun.spawn([process.execPath, command, "--db-copy", file], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(good.stdout).text(); const stderr = new Response(good.stderr).text();
  expect(await good.exited).toBe(0); await stderr;
  expect(JSON.parse(await stdout).status).toBe("compatible");
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.existsSync(env.TOKENATLAS_ARCHIVE)).toBe(false);
});
