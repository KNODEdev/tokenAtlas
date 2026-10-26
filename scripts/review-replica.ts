import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { ARCHIVE_ROOT, ARCHIVE_LOGICAL_ROOT, CONFIG_ROOT, resolveArchiveRootFromEnv } from "../src/config/paths";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../src/db/period-store";
import { configureGaugeJournal, flushGaugeJournal, pendingGaugeJournalLines, PROBE_JOURNAL_FILE, type ProbeJournalRow } from "../src/providers/core/journal";
import { journalKindOf, listJournalFiles } from "../src/providers/core/journal-files";
import { COMPACT_JOURNAL_VERSION, expandCompactProbe, expandProbeJournal } from "../src/providers/core/journal-compact";
import { persistProbeWindows } from "../src/providers/core/probe";
import { ingestGaugesAsync } from "../src/ingest/gauges";
import { SyncCoordinator, enterSyncPipeline } from "../src/sync/coordinator";
import { adaptersWith, noMirror, successfulNoop } from "../src/sync/test-support";
import { publishCurrentBatch } from "../src/server/current/store";
import { currentRegistry } from "../src/server/current/registry";
import { createFetchHandler, type AppContext } from "../src/server/api";
import { reviewPreflight } from "./review-preflight";
import type { CurrentEnvelope, CurrentSubscription } from "../src/web/lib/current-contract";

const VERSION = 1;
const MARKER = ".tokenatlas-replica.json";
const syntheticHome = "C:/Users/synthetic/.codex";
const declarations = ["MAIN", "LAPTOP"].map(machine => ({ id: "replica-synthetic", vendor: "codex", machine,
  home: `${ARCHIVE_LOGICAL_ROOT}/codex/${machine}-synthetic`, source_home: syntheticHome }));
const accounts = { version: 2 as const,
  subscriptions: [{ id: "replica-synthetic", vendor: "codex" }],
  sources: declarations.map(({ vendor, machine, home, source_home }) => ({ vendor, machine, home, source_home })) };
type Alias = "MAIN" | "LAPTOP";
type Manifest = { version: 1; experiment: string; machine: Alias; sha: string; helper_digest: string;
  device: string; archive: string; mode: "local" | "onedrive"; linked: string | null };
type Delivery = { version: 1; experiment: string; machine: Alias; sha: string; helper_digest: string;
  device: string; id: string; digest: string; receipt_digest: string; ts: string; pending: number };
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const device = () => digest(os.hostname());
const helperDigest = () => digest(fs.readFileSync(import.meta.path, "utf8"));
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeNew(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function within(a: string, b: string) {
  const relative = path.relative(a.toLowerCase(), b.toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function noLinks(file: string) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error("linked-root-refused");
    }
    if (path.dirname(current) === current) break;
  }
}
export function safeRoot(raw: string) {
  if (!raw || !path.isAbsolute(raw)) throw new Error("explicit-absolute-root-required");
  const root = path.resolve(raw);
  if (!/^tokenatlas-replica-[a-z0-9-]+$/.test(path.basename(root))) throw new Error("marked-root-required");
  noLinks(root);
  const forbidden = [ARCHIVE_ROOT, CONFIG_ROOT, resolveArchiveRootFromEnv({}),
    path.join(os.homedir(), ".tokenatlas"), path.resolve(import.meta.dir, "../_golden"),
    ...[process.env.TOKENATLAS_DB, process.env.TOKENATLAS_CONFIG, process.env.TOKENATLAS_ARCHIVE].filter(Boolean) as string[]];
  if (forbidden.some(p => within(path.resolve(p), root) || within(root, path.resolve(p)))) throw new Error("production-root-refused");
  return root;
}
function sha() {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.resolve(import.meta.dir, "..") });
  const value = result.stdout.toString().trim();
  if (result.exitCode || !/^[a-f0-9]{40}$/.test(value)) throw new Error("code-sha-unavailable");
  return value;
}
function validateManifest(m: Manifest) {
  if (m.version !== VERSION || !/^replica-[a-z0-9-]{1,60}$/.test(m.experiment)
    || !["MAIN", "LAPTOP"].includes(m.machine) || !["local", "onedrive"].includes(m.mode)
    || !/^[a-f0-9]{64}$/.test(m.device) || m.sha !== sha() || m.helper_digest !== helperDigest()) throw new Error("manifest-version-code-mismatch");
}
function load(root: string): Manifest {
  root = safeRoot(root);
  noLinks(path.join(root, MARKER));
  const m: Manifest = read(path.join(root, MARKER)); validateManifest(m);
  safeRoot(m.archive);
  if (within(root, m.archive) || within(m.archive, root)) throw new Error("roots-overlap");
  const archive = read(path.join(m.archive, MARKER));
  if (archive.version !== VERSION || archive.experiment !== m.experiment || archive.mode !== m.mode) throw new Error("archive-owner-mismatch");
  if (m.device !== device()) throw new Error("local-root-belongs-to-other-device");
  // Reject links before any DB, stage, or journal operation can follow them.
  const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); noLinks(file); if (entry.isDirectory()) visit(file);
  } };
  visit(root); visit(m.archive);
  return m;
}
export function initialize(root: string, archive: string, experiment: string, machine: Alias, mode: "local" | "onedrive", linked: string | null = null) {
  root = safeRoot(root); archive = safeRoot(archive);
  if (within(root, archive) || within(archive, root)) throw new Error("roots-overlap");
  const m: Manifest = { version: VERSION, experiment, machine, mode, linked, archive, sha: sha(), helper_digest: helperDigest(), device: device() };
  validateManifest(m);
  if (linked !== null && linked !== "tx97098") throw new Error("unknown-historical-link");
  if (mode === "onedrive") {
    const cloud = process.env.OneDrive || process.env.ONEDRIVE;
    if (!cloud || !within(path.resolve(cloud), archive)) throw new Error("known-onedrive-root-required");
  }
  if (fs.existsSync(root)) throw new Error("existing-local-root-refused");
  if (fs.existsSync(archive)) {
    const owner = read(path.join(archive, MARKER));
    if (owner.version !== VERSION || owner.experiment !== experiment || owner.mode !== mode) throw new Error("archive-owner-mismatch");
  } else {
    fs.mkdirSync(archive); writeNew(path.join(archive, MARKER), { version: VERSION, experiment, mode });
  }
  fs.mkdirSync(root); writeNew(path.join(root, MARKER), m);
  fs.mkdirSync(path.join(root, "config"));
  const db = new Database(path.join(root, "synthetic.sqlite"), { create: true });
  try {
    applyDrizzleMigrations(drizzle(db));
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, declarations.map(source => ({
      provider: "codex", subject: `codex/${source.machine}-synthetic`.toLowerCase(), value: "replica-synthetic",
      from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
      readings: 0, evidence: "synthetic replica experiment",
    })));
  }
  finally { db.close(true); }
  return m;
}
function target(m: Manifest) { return { archiveRoot: m.archive, journalRoot: path.join(m.archive, "gauges", `${m.machine}-synthetic`) }; }
function delivery(m: Manifest, payload: string): Delivery {
  // The synthetic delivery is the first of its counter, so its compact line is self-contained.
  const row = expandCompactProbe(JSON.parse(payload), null).outer;
  if (row.journal_version !== COMPACT_JOURNAL_VERSION || !/^[a-f0-9-]{36}$/.test(String(row.journal_entry_id))
    || row.subject !== "replica-synthetic" || row.machine !== m.machine || row.used_percent !== 42) throw new Error("non-synthetic-delivery");
  return { version: VERSION, experiment: m.experiment, machine: m.machine, sha: m.sha, helper_digest: m.helper_digest,
    device: m.device, id: String(row.journal_entry_id), digest: digest(payload),
    receipt_digest: digest(PROBE_JOURNAL_FILE + "\0" + payload.trim()), ts: String(row.ts), pending: 1 };
}
export function produce(root: string) {
  const m = load(root);
  if (fs.existsSync(path.join(root, "producer.json"))) throw new Error("evidence-exists");
  if (process.env.TOKENATLAS_MACHINE !== m.machine || process.env.TOKENATLAS_LOGIN !== "synthetic") throw new Error("use-cli-producer-isolated-process");
  const db = new Database(path.join(root, "synthetic.sqlite"));
  try {
    configureGaugeJournal(target(m).journalRoot, { archiveRoot: m.archive });
    const prior = db.query("SELECT payload FROM gauge_journal_outbox").all() as { payload: string }[];
    if (prior.length > 1) throw new Error("unexpected-pending-work");
    if (!prior.length) {
      if ((db.query("SELECT count(*) AS n FROM probe_windows").get() as { n: number }).n) throw new Error("empty-pending-local-only");
      persistProbeWindows(db, "codex", "replica-synthetic", new Date().toISOString(), [{ kind: "primary", group: "codex", scope: null,
        plan: "plus", reportedPercentSide: "used", usedPercent: 42, remainingPercent: null, vendorPercent: 42,
        windowMinutes: 300, allowance: null, used: null, remaining: null, resetsAt: null, rateLimitReached: false,
        resetCredits: null, profile: "synthetic", ok: true, error: null, extra: { home: syntheticHome } }]);
    }
    const row = db.query("SELECT payload FROM gauge_journal_outbox").get() as { payload: string };
    writeNew(path.join(root, "producer.json"), delivery(m, row.payload));
  } finally { configureGaugeJournal(null); db.close(true); }
}
/** A delivery writer may briefly block rollback-journal readers; acceptance still requires an empty queue. */
export async function waitForGaugeJournal(sqlite: Database): Promise<void> {
  const end = Date.now() + 5000;
  for (;;) {
    try {
      if (pendingGaugeJournalLines(sqlite) === 0) return;
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "SQLITE_BUSY") throw error;
    }
    if (Date.now() >= end) throw new Error("archive-delivery-pending");
    await Bun.sleep(25);
  }
}
export async function flush(root: string) {
  const m = load(root), expected: Delivery = read(path.join(root, "producer.json"));
  const db = new Database(path.join(root, "synthetic.sqlite"));
  const pending = pendingGaugeJournalLines(db);
  const row = db.query("SELECT payload FROM gauge_journal_outbox").get() as { payload: string } | null;
  if (row && JSON.stringify(delivery(m, row.payload)) !== JSON.stringify(expected)) { db.close(); throw new Error("pending-digest-mismatch"); }
  if (fs.existsSync(path.join(root, "flush.json"))) { db.close(); throw new Error("evidence-exists"); }
  try {
    // The background writer's delivery job, run here directly on the synthetic database.
    const writer = new Database(path.join(root, "synthetic.sqlite"));
    try {
      for (let batch = 0; batch < 64 && pendingGaugeJournalLines(writer); batch++) {
        const delivered = flushGaugeJournal(writer, target(m));
        if (delivered.error) throw new Error(`archive-delivery-${delivered.error}`);
      }
    } finally { writer.close(); }
    await waitForGaugeJournal(db);
    const file = path.join(target(m).journalRoot, PROBE_JOURNAL_FILE);
    const payload = verifyDownloaded(file, expected);
    if (JSON.stringify(delivery(m, payload)) !== JSON.stringify(expected)) throw new Error("producer-manifest-mismatch");
    const output = path.join(m.archive, `producer-${m.machine}.json`);
    if (fs.existsSync(output)) {
      if (JSON.stringify(read(output)) !== JSON.stringify(expected)) throw new Error("producer-evidence-conflict");
    } else writeNew(output, expected);
    const result = { pending_after_restart: pending, pending_after_flush: 0, local_archive: "PASS", remote: "NOT-RUN", empty_pending_local_only: pending === 0 };
    writeNew(path.join(root, "flush.json"), result); return result;
  } finally { db.close(true); }
}
/** The journal is written as dated segments: everything of this file's kind in its store, oldest first. */
function journalText(file: string): string {
  const store = path.dirname(file), kind = journalKindOf(path.basename(file));
  if (kind == null) throw new Error("journal-kind-required");
  // A torn final line of one segment must not run into the next segment's first line.
  return listJournalFiles(store, kind).map(name => fs.readFileSync(path.join(store, name), "utf8"))
    .map(text => text === "" || text.endsWith("\n") ? text : text + "\n").join("");
}
export function verifyDownloaded(file: string, expected: Delivery) {
  if (expected.version !== VERSION || !/^[a-f0-9]{64}$/.test(expected.digest) || !/^[a-f0-9]{64}$/.test(expected.receipt_digest)
    || !/^[a-f0-9]{64}$/.test(expected.device)) throw new Error("invalid-delivery-manifest");
  const lines = journalText(file).split("\n").filter(Boolean);
  const matching = lines.filter(line => JSON.parse(line).journal_entry_id === expected.id);
  if (!matching.length || matching.some(line => digest(line) !== expected.digest || digest(PROBE_JOURNAL_FILE + "\0" + line.trim()) !== expected.receipt_digest)) throw new Error("downloaded-digest-mismatch");
  return matching[0]!;
}
export function inspectHistory(manifestFile: string, journalFile: string) {
  try {
    noLinks(manifestFile); noLinks(journalFile);
    const prior: Delivery = read(manifestFile);
    if (prior.experiment !== "tx97098" || prior.sha !== sha() || prior.helper_digest !== helperDigest()) throw new Error("historical-version-code-mismatch");
    const payload = verifyDownloaded(journalFile, prior);
    const row = JSON.parse(payload);
    if (row.subject !== "replica-synthetic" || row.machine !== prior.machine || row.used_percent !== 42) throw new Error("historical-synthetic-mismatch");
    return { history: "VERIFIED-READ-ONLY", experiment: "tx97098", id: prior.id, digest: prior.digest, cross_pc: "NOT-RUN" };
  } catch {
    return { history: "NEW-LINKED-EXPERIMENT-REQUIRED", experiment: "tx97098", id: null, digest: null, cross_pc: "NOT-RUN" };
  }
}
function verifyCurrent(body: CurrentEnvelope<CurrentSubscription>, payload: string, journal: string) {
  const rows = expandProbeJournal(journal.split(String.fromCharCode(10)).filter(Boolean)) as unknown as ProbeJournalRow[];
  const row = rows.find(candidate => candidate.journal_entry_id === JSON.parse(payload).journal_entry_id);
  if (!row) throw new Error("current-projection-mismatch");
  const instant = (value: string | null) => value === null ? null : new Date(value).toISOString();
  const measuredAt = instant(row.ts);
  const identity = { kind: row.kind, group: row.limit_group || null, scope: row.scope || null,
    window_minutes: row.window_minutes == null || row.window_minutes < 0 ? null : row.window_minutes };
  const limits = body.data.limits.filter(limit => Object.entries(identity).every(([key, value]) => limit[key as keyof typeof limit] === value));
  const values = { ...identity, measured_at: measuredAt, machine: row.machine, plan: row.plan,
    used_percent: row.used_percent ?? (row.remaining_percent == null ? null : 100 - row.remaining_percent),
    remaining_percent: row.remaining_percent ?? (row.used_percent == null ? null : 100 - row.used_percent),
    used: row.used, remaining: row.remaining, allowance: row.allowance, resets_at: instant(row.resets_at),
    rate_limit_reached: row.rate_limit_reached == null ? null : row.rate_limit_reached === 1, basis: "measured" };
  const limit = limits[0];
  if (body.status !== "ready" || body.data.id !== row.subject || body.data.vendor !== row.provider
    || body.data.limits_truncated || limits.length !== 1 || !limit
    || !Object.entries(values).every(([key, value]) => limit[key as keyof typeof limit] === value)) throw new Error("current-projection-mismatch");
  // Current has no delivery ID: equal-time distinct deliveries cannot establish unique provenance.
  for (const other of rows) {
    if (other.journal_entry_id !== row.journal_entry_id && other.provider === row.provider && other.subject === row.subject
      && other.machine === row.machine && instant(other.ts) === measuredAt && other.kind === row.kind
      && (other.limit_group || null) === identity.group && (other.scope || null) === identity.scope
      && (other.window_minutes == null || other.window_minutes < 0 ? null : other.window_minutes) === identity.window_minutes) {
      throw new Error("current-delivery-ambiguous");
    }
  }
}
export async function receive(root: string, producer: Alias) {
  const m = load(root);
  if (!["MAIN", "LAPTOP"].includes(producer) || producer === m.machine) throw new Error("distinct-producer-alias-required");
  const expected: Delivery = read(path.join(m.archive, `producer-${producer}.json`));
  if (expected.experiment !== m.experiment || expected.machine !== producer || expected.sha !== m.sha || expected.helper_digest !== m.helper_digest) throw new Error("producer-manifest-mismatch");
  const file = path.join(m.archive, "gauges", `${producer}-synthetic`, PROBE_JOURNAL_FILE);
  const payload = verifyDownloaded(file, expected);
  if (JSON.stringify(delivery({ ...m, machine: producer, device: expected.device }, payload)) !== JSON.stringify(expected)) throw new Error("synthetic-manifest-mismatch");
  const output = path.join(root, `receiver-${producer}.json`);
  if (fs.existsSync(output)) throw new Error("evidence-exists");
  const dbPath = path.join(root, "synthetic.sqlite");
  const coordinator = new SyncCoordinator({ dbPath, rootDir: path.resolve(import.meta.dir, ".."), mirror: noMirror,
    // This adapter discovers its isolated synthetic archive, outside the installation's root.
    archiveInputs: () => undefined,
    configFingerprint: () => "replica-v1", sourceFingerprint: () => digest(journalText(file)),
    prepareStage: () => {}, refreshDerived: () => {}, adapters: adaptersWith({ gauges: async ctx => {
      const result = (await ingestGaugesAsync({ atlasPath: ctx.stageDbPath, archiveRoot: m.archive, ownStore: `${m.machine}-synthetic`, force: true }));
      return { ...successfulNoop(), processedInputs: result.files, writtenRows: result.rows };
    } }) });
  try {
    const result = await enterSyncPipeline(coordinator, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "full" }).completion;
    if (result.status !== "success") throw new Error("receiver-sync-failed");
  } finally { coordinator.close(); }
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    let settled = false;
    for (let step = 0; step < 500; step++) {
      if (!publishCurrentBatch(db, currentRegistry(accounts.subscriptions, now), now, 32, accounts)) { settled = true; break; }
    }
    if (!settled) throw new Error("current-projection-preparation-incomplete");
    const receipt = db.query("SELECT payload_hash FROM gauge_journal_receipts WHERE entry_id=?").get(expected.id) as { payload_hash: string } | null;
    if (receipt?.payload_hash !== expected.receipt_digest) throw new Error(`receipt-mismatch: expected ${expected.receipt_digest}, got ${receipt?.payload_hash ?? "absent"}`);
    const context = { sqlite: db, accounts, homeConflict: null, eraErrors: [], homeToSubId: new Map(),
      subIdToHomes: new Map(), claudeGauge: {}, grokGauge: {}, rateCards: { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {} } } as unknown as AppContext;
    const response = await createFetchHandler(context)(new Request("http://fixture/api/subscriptions/replica-synthetic/current"));
    const body = await response.json();
    if (response.status !== 200) throw new Error("current-projection-mismatch");
    verifyCurrent(body, payload, journalText(file));
    const evidence = { version: VERSION, experiment: m.experiment, sha: m.sha, helper_digest: m.helper_digest, producer, receiver: m.machine,
      id: expected.id, digest: expected.digest, receipt_digest: receipt.payload_hash, producer_device: expected.device, receiver_device: m.device,
      file_receipt_current: "PASS", multi_pc: m.mode === "onedrive" && expected.device !== m.device ? "PASS" : "NOT-RUN", latency_ms: null };
    writeNew(output, evidence); return evidence;
  } finally { db.close(true); }
}
export function returnReport(root: string) {
  const m = load(root);
  const opposite: Alias = m.machine === "MAIN" ? "LAPTOP" : "MAIN";
  const file = path.join(root, `receiver-${opposite}.json`);
  const receiver = fs.existsSync(file) ? read(file) : null;
  const flushed = fs.existsSync(path.join(root, "flush.json")) ? read(path.join(root, "flush.json")) : null;
  const producer: Delivery | null = fs.existsSync(path.join(root, "producer.json")) ? read(path.join(root, "producer.json")) : null;
  if (producer && flushed) {
    const payload = verifyDownloaded(path.join(target(m).journalRoot, PROBE_JOURNAL_FILE), producer);
    if (JSON.stringify(delivery(m, payload)) !== JSON.stringify(producer) || flushed.local_archive !== "PASS"
      || ![0, 1].includes(flushed.pending_after_restart) || flushed.pending_after_flush !== 0) throw new Error("return-producer-mismatch");
  }
  if (receiver) {
    const expected: Delivery = read(path.join(m.archive, `producer-${opposite}.json`));
    verifyDownloaded(path.join(m.archive, "gauges", `${opposite}-synthetic`, PROBE_JOURNAL_FILE), expected);
    if (receiver.version !== VERSION || receiver.experiment !== m.experiment || receiver.sha !== m.sha || receiver.helper_digest !== m.helper_digest
      || receiver.producer !== opposite || receiver.receiver !== m.machine || receiver.id !== expected.id || receiver.digest !== expected.digest
      || receiver.receipt_digest !== expected.receipt_digest || receiver.producer_device !== expected.device || receiver.receiver_device !== m.device
      || receiver.file_receipt_current !== "PASS") throw new Error("return-evidence-mismatch");
    const db = new Database(path.join(root, "synthetic.sqlite"), { readonly: true });
    try {
      const receipt = db.query("SELECT payload_hash FROM gauge_journal_receipts WHERE entry_id=?").get(expected.id) as { payload_hash: string } | null;
      if (receipt?.payload_hash !== expected.receipt_digest) throw new Error("return-receipt-mismatch");
    } finally { db.close(true); }
  }
  const report = { schema_version: VERSION, marker: "TOKENATLAS_REPLICA_RETURN_V1", check: "replica-delivery", experiment_id: m.experiment,
    linked_experiment: m.linked, continuity: m.linked ? "NEW-LINKED-NOT-RESUMED" : "NEW", machine_alias: m.machine,
    code_sha: m.sha, helper_digest: m.helper_digest, preflight: reviewPreflight(path.join(root, "synthetic.sqlite")).status,
    producer_delivery: producer && flushed ? { id: producer.id, digest: producer.digest,
      pending_after_restart: flushed.pending_after_restart, pending_after_flush: flushed.pending_after_flush } : null,
    preflight_scope: "synthetic-local-only", main_actual_preflight: "NOT-RUN", private_golden: { plan_observations: "NOT-RUN", subscription_months: "NOT-RUN" },
    local_archive: flushed?.local_archive === "PASS" ? "PASS" : "NOT-RUN", received: receiver?.file_receipt_current === "PASS" ? "PASS" : "NOT-RUN",
    delivery_id: receiver?.id ?? null, payload_digest: receiver?.digest ?? null,
    multi_pc: receiver && m.mode === "onedrive" && receiver.producer_device !== m.device ? "PASS" : "NOT-RUN", direction: receiver ? `${opposite}-to-${m.machine}` : null,
    opposite_direction: "NOT-RUN", cross_pc_latency_ms: null, optional_remote_malformed: "NOT-RUN", owner_acceptance: "NOT-RECORDED" };
  writeNew(path.join(root, "return-report.json"), report); return report;
}

if (import.meta.main) {
  try {
    const [phase, root, ...args] = process.argv.slice(2);
    if (!root) throw new Error("explicit-root-required");
    if (phase === "inspect-history" && args.length === 1) console.log(JSON.stringify(inspectHistory(root, args[0]!)));
    else if (phase === "init" && args.length >= 4 && args.length <= 5) initialize(root, args[0]!, args[1]!, args[2] as Alias, args[3] as "local" | "onedrive", args[4] ?? null);
    else if (phase === "producer" && !args.length) {
      const m = load(root);
      const child = Bun.spawn([process.execPath, import.meta.path, "producer-child", root], { stdout: "ignore", stderr: "ignore",
        env: { ...process.env, TOKENATLAS_MACHINE: m.machine, TOKENATLAS_LOGIN: "synthetic" } });
      if (await child.exited) throw new Error("producer-process-failed");
    } else if (phase === "producer-child" && !args.length) produce(root);
    else if (phase === "flush" && !args.length) await flush(root);
    else if (phase === "receiver" && args.length === 1) await receive(root, args[0] as Alias);
    else if (phase === "return-report" && !args.length) console.log(JSON.stringify(returnReport(root), null, 2));
    else throw new Error("usage-init-producer-flush-receiver-return-report");
  } catch { console.error("Replica phase refused or failed; retained private evidence requires inspection."); process.exitCode = 1; }
}
