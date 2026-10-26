import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ARCHIVE_ROOT, toArchivePhysicalPath } from "../src/config/paths";
import { createTemporaryWorkspace } from "../src/config/temporary-storage";
import { Database } from "../src/db/sqlite";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";

// Bounded P0 sample, not a claim of whole-archive recovery or completeness.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--copy" || !args[1]) throw new Error("Usage: bun scripts/price-ledger-source-sample.ts --copy <frozen-copy.sqlite>");
const frozen = frozenLedgerCopy(args[1]);
const db = new Database(frozen.copy, { readonly: true });
type Sample = { model: string | null; home: string | null; path: string | null; first_ts: string; last_ts: string; events: number };
type Evidence = Sample & { status: string; [key: string]: unknown };
type SourceRecord = { type?: unknown; payload?: { type?: unknown; id?: unknown; thread_id?: unknown;
  session_id?: unknown; response_id?: unknown; thread_settings?: { service_tier?: unknown }; info?: { model_context_window?: unknown } } };
const evidence: Evidence[] = [];
try {
  // Two files per model (first and last lexical event times) with missing tier evidence.
  const files = db.query(`WITH copies AS (SELECT model,home,path,MIN(ts) first_ts,MAX(ts) last_ts,COUNT(*) events
      FROM events WHERE service_tier IS NULL GROUP BY model,home,path),
    ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY model ORDER BY first_ts,home,path) first_rank,
      ROW_NUMBER() OVER(PARTITION BY model ORDER BY last_ts DESC,home,path) last_rank FROM copies)
    SELECT model,home,path,first_ts,last_ts,events FROM ranked WHERE first_rank=1 OR last_rank=1 ORDER BY model,first_ts`).all() as Sample[];
  for (const sample of files) {
    if (!sample.path) { evidence.push({ ...sample, status: "missing-copy-path" }); continue; }
    const physical = toArchivePhysicalPath(sample.path);
    const relative = path.relative(ARCHIVE_ROOT, physical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      evidence.push({ ...sample, status: "not-in-configured-archive" }); continue;
    }
    if (!fs.existsSync(physical)) { evidence.push({ ...sample, status: "unavailable" }); continue; }
    const before = fs.statSync(physical);
    if (!before.isFile() || before.size > 25 * 1024 * 1024) { evidence.push({ ...sample, status: "outside-25MiB-sample-bound", bytes: before.size }); continue; }
    const bytes = fs.readFileSync(physical);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const types: Record<string, number> = Object.create(null), tiers: Record<string, number> = Object.create(null);
    const sessionIds = new Set<string>(), requestKeys = new Set<string>();
    const identityHash = (identity: unknown) => createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    let malformed = 0, contextReadings = 0, compacted = 0, explicitTierNulls = 0;
    let richRequests = 0, missingRequestIdentity = 0, repeatedRequestIdentity = 0;
    // Record only whitelisted accounting metadata; never persist conversation text or credentials.
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: SourceRecord | null;
      try { record = JSON.parse(line) as SourceRecord | null; } catch { malformed++; continue; }
      const type = record?.type;
      if (typeof type === "string") types[type] = (types[type] ?? 0) + 1;
      if (type === "thread_settings_applied" || type === "event_msg" && record?.payload?.type === "thread_settings_applied") {
        const settings = record?.payload?.thread_settings;
        if (settings && Object.hasOwn(settings, "service_tier")) {
          const value = settings.service_tier;
          if (value === null) explicitTierNulls++;
          else if (typeof value === "string") tiers[value] = (tiers[value] ?? 0) + 1;
        }
      }
      if (type === "session_meta" && typeof record?.payload?.id === "string" && record.payload.id.trim()) {
        sessionIds.add(identityHash(record.payload.id));
      }
      if (type === "token_usage_record") {
        richRequests++;
        const thread = record?.payload?.thread_id || record?.payload?.session_id, response = record?.payload?.response_id;
        if (typeof thread === "string" && thread.trim() && typeof response === "string" && response.trim()) {
          const key = identityHash([thread, response]);
          if (requestKeys.has(key)) repeatedRequestIdentity++;
          requestKeys.add(key);
        } else missingRequestIdentity++;
      }
      if (record?.payload?.info?.model_context_window != null) contextReadings++;
      if (type === "compacted" || record?.payload?.type === "context_compacted") compacted++;
    }
    const verifiedHash = createHash("sha256").update(fs.readFileSync(physical)).digest("hex");
    const after = fs.statSync(physical);
    // OneDrive hydration changes attributes/ctime; identical bytes and mtime remain the evidence.
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs && contentHash === verifiedHash;
    evidence.push({ ...sample, status: stable ? "sampled" : "changed-during-sample; rejected", bytes: before.size,
      sha256: stable ? contentHash : null, attributes_changed: before.ctimeMs !== after.ctimeMs,
      types, tiers, explicit_tier_nulls: explicitTierNulls, context_readings: contextReadings, compaction_records: compacted, malformed,
      session_identity_hashes: [...sessionIds].sort(), rich_requests: richRequests, unique_request_identities: requestKeys.size,
      missing_request_identity: missingRequestIdentity, repeated_request_identity: repeatedRequestIdentity });
  }
  frozen.assertUnchanged();
  const workspace = createTemporaryWorkspace("price-ledger-source-sample", frozen.live).directory;
  const report = path.join(workspace, "sample.json");
  fs.writeFileSync(report, JSON.stringify({ schema: 1, copy: frozen.copy, archive: ARCHIVE_ROOT,
    selection: "First and last file per model among events with NULL raw tier; <=25MiB per file",
    limitations: "Sample only; source observations may have arrived after the frozen database. No recovery or writes.", evidence }, null, 2));
  console.log(JSON.stringify({ report, selected: files.length, distinct_files: new Set(files.map(file => file.path)).size,
    sampled: evidence.filter(item => item.status === "sampled").length }));
} finally { db.close(); }
