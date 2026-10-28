import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Database } from "./sqlite";

const migrations = path.resolve(import.meta.dir, "../../drizzle");

export function migrationFixtureThrough(root: string, tag: string): string {
  const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"));
  const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
  if (last < 0) throw new Error(`Unknown fixture migration: ${tag}`);
  journal.entries = journal.entries.slice(0, last + 1);
  const folder = path.join(root, `migrations-through-${tag}`);
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries)
    fs.copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  return folder;
}

/** Replay the historical range under test without rerunning unrelated additions already present in the fixture. */
export function replayFixtureMigrations(db: Database, root: string, firstTag: string, lastTag: string): void {
  const folder = migrationFixtureThrough(root, lastTag);
  const { entries } = JSON.parse(fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8"));
  const first = entries.find((entry: { tag: string }) => entry.tag === firstTag);
  if (!first) throw new Error(`Unknown fixture migration: ${firstTag}`);
  const later = db.query("SELECT hash, created_at FROM __drizzle_migrations WHERE created_at>? ORDER BY created_at")
    .all(entries.at(-1).when) as Array<{ hash: string; created_at: number }>;
  db.query("DELETE FROM __drizzle_migrations WHERE created_at>=?").run(first.when);
  try { migrate(drizzle(db), { migrationsFolder: folder }); }
  finally {
    for (const row of later)
      db.query("INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)").run(row.hash, row.created_at);
  }
}
