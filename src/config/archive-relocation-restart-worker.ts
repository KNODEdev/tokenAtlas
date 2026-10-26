import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ingestClaude } from "../ingest/claude";
import { ingestGeminiAsync } from "../ingest/gemini";
import { declaredCodexHomes, ensureCodexSchema, readableCodexHomes, syncCodex } from "../ingest/codex";
import { configFile } from "./paths";
import { digest } from "./canonical-json";

const [mode, dbPath] = process.argv.slice(2);
if (!mode || !dbPath) throw new Error("mode and dbPath required");

if (mode === "codex") {
  // The adapter's choice when no archive home is named: the declared homes readable here.
  const db = new Database(dbPath);
  try { ensureCodexSchema(db); console.log(JSON.stringify(await syncCodex(db, { homes: readableCodexHomes(declaredCodexHomes()) }))); }
  finally { db.close(); }
  process.exit(0);
}

let ingested: { claude?: unknown; gemini?: unknown } = {};
if (mode === "ingest") {
  const archive = process.env.TOKENATLAS_ARCHIVE!;
  ingested.claude = await ingestClaude({
    dbPath,
    store: "live",
    path: path.join(archive, "claude", "fixture", "projects"),
    skipMigrations: false,
  });
  ingested.gemini = (await ingestGeminiAsync(path.join(archive, "gemini", "fixture", "conversations"), "gemini-fixture", {
    archivedInput: true, atlasPath: dbPath, rootDir: path.dirname(configFile("accounts.json")),
  }));
}

const sqlite = new Database(dbPath, { readonly: true });
try {
  const table = (name: string) => !!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const rows = (name: string, columns: string) => table(name)
    ? sqlite.query(`SELECT ${columns} FROM ${name} ORDER BY 1,2`).all()
    : [];
  const accounts = configFile("accounts.json");
  const document = JSON.parse(fs.readFileSync(accounts, "utf8"));
  console.log(JSON.stringify({
    ingested,
    accounts,
    accountsDigest: digest(document),
    claudeFiles: rows("claude_files", "store,path,size,mtime,calls"),
    geminiFiles: rows("gemini_files", "store,path,size,mtime,generations"),
    codexFiles: rows("files", "home,path,size,mtime,events"),
    claudeEvents: table("claude_events") ? sqlite.query("SELECT count(*) n,coalesce(sum(in_uncached+in_cache_read+in_cache_write+out_total),0) tokens FROM claude_events").get() : null,
    geminiEvents: table("gemini_events") ? sqlite.query("SELECT count(*) n,coalesce(sum(fresh_in+cached_in+out_total),0) tokens,coalesce(sum(usd),0) usd FROM gemini_events").get() : null,
    codexEvents: table("events") ? sqlite.query("SELECT count(*) n,coalesce(sum(in_tok+out_tok),0) tokens FROM events").get() : null,
  }));
} finally {
  sqlite.close();
}
