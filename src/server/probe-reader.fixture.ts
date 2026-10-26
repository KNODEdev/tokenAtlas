import type { Database } from "../db/sqlite";
import { createProbeCollection, acceptProbeFact, mapProbeLegacy } from "../db/probe-facts";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { currentRegistry } from "./current/registry";
import type { AccountsV2, SubscriptionV2, SourceV2 } from "../config/accounts-v2";
import { publishCurrentBatch } from "./current/store";
import { probeArchiveSourceOf } from "./probe-source";
import { preparedProbeAccountIndexReady } from "./current/probe-account-reader";
import { probeSourcesPending } from "../db/probe-sources";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { installAnalysisTracking } from "../db/analysis";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";

/** Small test databases sometimes model only the tables needed by the assertion. */
function ensureProbeReaderSchema(db: Database): void {
  const existing = (name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  if (!existing("account_periods")) db.exec(`CREATE TABLE account_periods (
    id INTEGER PRIMARY KEY, provider TEXT NOT NULL, source TEXT NOT NULL, from_ts TEXT NOT NULL, until_ts TEXT,
    account TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('observed','declared')), first_seen TEXT,
    last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL,
    UNIQUE(provider,source,origin,from_ts))`);
  if (!existing("probe_windows")) db.exec(`CREATE TABLE probe_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, subject TEXT NOT NULL, ts TEXT NOT NULL,
    kind TEXT NOT NULL, limit_group TEXT, scope TEXT, plan TEXT, window_minutes REAL, used_percent REAL,
    remaining_percent REAL, vendor_percent REAL, allowance REAL, used REAL, remaining REAL, resets_at TEXT,
    rate_limit_reached INTEGER, reset_credits INTEGER, machine TEXT, profile TEXT, extra TEXT,
    reported_percent_side TEXT NOT NULL DEFAULT 'used', ok INTEGER, error TEXT)`);
  const probeColumns = new Set((db.query("PRAGMA table_info(probe_windows)").all() as {name:string}[]).map(row=>row.name));
  const additions: Record<string,string> = {
    id:"INTEGER", provider:"TEXT", subject:"TEXT", ts:"TEXT", kind:"TEXT", limit_group:"TEXT", scope:"TEXT", plan:"TEXT",
    window_minutes:"REAL", used_percent:"REAL", remaining_percent:"REAL", vendor_percent:"REAL", allowance:"REAL", used:"REAL",
    remaining:"REAL", resets_at:"TEXT", rate_limit_reached:"INTEGER", reset_credits:"INTEGER", machine:"TEXT", profile:"TEXT",
    extra:"TEXT", reported_percent_side:"TEXT NOT NULL DEFAULT 'used'", ok:"INTEGER", error:"TEXT",
  };
  for (const [name,type] of Object.entries(additions)) if (!probeColumns.has(name))
    db.exec(`ALTER TABLE probe_windows ADD COLUMN ${name} ${type}`);
  db.exec("UPDATE probe_windows SET id=rowid WHERE id IS NULL");
  db.exec(`CREATE TABLE IF NOT EXISTS probe_observations(id TEXT PRIMARY KEY NOT NULL,header TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS probe_counters(id TEXT PRIMARY KEY NOT NULL,observation_id TEXT NOT NULL REFERENCES probe_observations(id),
      discriminator TEXT NOT NULL,payload TEXT NOT NULL,payload_digest TEXT NOT NULL,UNIQUE(observation_id,discriminator));
    CREATE TABLE IF NOT EXISTS probe_fact_legacy_map(id TEXT PRIMARY KEY NOT NULL,namespace TEXT NOT NULL,legacy_id INTEGER,
      evidence_hash TEXT NOT NULL,counter_id TEXT NOT NULL REFERENCES probe_counters(id),reason TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS probe_fact_legacy_pointer ON probe_fact_legacy_map(namespace,legacy_id);
    CREATE TABLE IF NOT EXISTS probe_fact_backfill_checkpoints(id TEXT PRIMARY KEY NOT NULL,namespace TEXT NOT NULL,cursor INTEGER NOT NULL,evidence_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS current_probe_subjects(provider TEXT NOT NULL,subject TEXT NOT NULL,data TEXT NOT NULL,
      generated_at TEXT NOT NULL,next_refresh_at TEXT,PRIMARY KEY(provider,subject));
    CREATE TABLE IF NOT EXISTS current_projection_dirty(provider TEXT NOT NULL,subject TEXT NOT NULL,PRIMARY KEY(provider,subject));
    CREATE TABLE IF NOT EXISTS current_projection_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL DEFAULT 1,
      probe_revision INTEGER NOT NULL DEFAULT 0,published_probe_revision INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,
      config_fingerprint TEXT NOT NULL DEFAULT '',generated_at TEXT,error_code TEXT);
    INSERT OR IGNORE INTO current_projection_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS subscription_current(id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);`);
  installFactDayRevisions(db);
}

export interface ProbeReaderFixtureSource {
  id: string;
  vendor: string;
  machine: string;
  login: string;
  home: string;
  source_home: string;
  account?: string;
}
export type ProbeReaderFixtureRow = { id: number; provider: string; subject: string; ts: string };
type ProbeReaderFixtureDeclaration = {
  id: string;
  vendor?: string;
  account_key?: string;
  label?: string;
  note?: string;
  status?: "active" | "paused" | "cancelled" | "unknown";
  from?: string;
  until?: string;
  plan?: string;
  machine?: string | null;
  login?: string | null;
  home?: string | null;
  source_home?: string | null;
  account?: string | null;
};

/** Split a legacy-shaped test fixture into current identity metadata and physical sources. */
export function splitProbeReaderFixtureConfig(
  declarations: readonly ProbeReaderFixtureDeclaration[],
): AccountsV2 {
  const subscriptions = new Map<string, SubscriptionV2[]>();
  const sourceRows = new Map<string, SourceV2>();
  for (const declaration of declarations) {
    const vendor = declaration.vendor ?? "codex";
    const key = `${vendor.toLowerCase()}\0${declaration.id.toLowerCase()}`;
    const identities = subscriptions.get(key) ?? [];
    identities.push({ id: declaration.id, vendor, account: declaration.account ?? undefined,
      account_key: declaration.account_key, label: declaration.label, note: declaration.note, status: declaration.status });
    subscriptions.set(key, identities);
    if (!declaration.home) continue;
    const physical: SourceV2 = { vendor, home: declaration.home,
      ...(declaration.machine ? { machine: declaration.machine } : {}),
      ...(declaration.login ? { login: declaration.login } : {}),
      ...(declaration.source_home ? { source_home: declaration.source_home } : {}) };
    const physicalKey = JSON.stringify([vendor.toLowerCase(), physical.machine?.toLowerCase() ?? "",
      physical.login?.toLowerCase() ?? "", physical.home.toLowerCase(), physical.source_home?.toLowerCase() ?? ""]);
    sourceRows.set(physicalKey, physical);
  }
  const metadata = [...subscriptions.values()].map(rows => {
    const first = rows[0]!;
    const accountValues = new Set(rows.map(row => row.account).filter((value): value is string => !!value));
    const accountKeys = new Set(rows.map(row => row.account_key).filter((value): value is string => !!value));
    return { id: first.id, vendor: first.vendor,
      ...(accountValues.size === 1 ? { account: [...accountValues][0]! } : {}),
      ...(accountKeys.size === 1 ? { account_key: [...accountKeys][0]! } : {}),
      ...(first.label ? { label: first.label } : {}), ...(first.note ? { note: first.note } : {}),
      ...(first.status ? { status: first.status } : {}) };
  });
  return { version: 2, subscriptions: metadata, sources: [...sourceRows.values()] };
}

/** A declared source whose account ownership is supplied separately through account_periods. */
export function probeReaderFixtureSource(vendor: string, id: string): ProbeReaderFixtureSource {
  const machine = `FIXTURE-${vendor}-${id}`;
  const login = `fixture-${id}`;
  const home = vendor === "glm"
    ? `${ARCHIVE_LOGICAL_ROOT}/glm/${machine}`
    : `${ARCHIVE_LOGICAL_ROOT}/${vendor}/${machine}-${login}`;
  return { id, vendor, machine, login, home, source_home: `C:/probe-fixtures/${machine}/.${vendor}`,
    account: `${id}@example.test` };
}

/** Link fixture projections to explicit physical facts, declare their account periods, and settle v2. */
export function prepareProbeReaderFixture(db: Database, declarations: readonly ProbeReaderFixtureDeclaration[],
  accountForRow: (row: ProbeReaderFixtureRow) => string | null = row => row.subject,
  /** False leaves the limit-window producer to the caller (tests that measure it). */
  limitWindows = true): void {
  const sources: ProbeReaderFixtureSource[] = declarations.map(declaration => {
    const vendor = declaration.vendor ?? "codex";
    const machine = declaration.machine?.trim() || `FIXTURE-${vendor}-${declaration.id}`;
    const login = declaration.login?.trim() || `fixture-${declaration.id}`;
    return { id: declaration.id, vendor, machine, login,
      home: declaration.home?.trim() || `${ARCHIVE_LOGICAL_ROOT}/${vendor}/${machine}-${login}`,
      source_home: declaration.source_home?.trim() || `C:/probe-fixtures/${machine}/.${vendor}` };
  });
  // The maintenance worker publishes limit windows after the projection; readers only read them.
  const windows = () => { if (limitWindows) prepareLimitWindowsFixture(db, { sources }); };
  // Readings added since the last preparation are linked and their evidence written, as the server would.
  if (preparedProbeAccountIndexReady(db) && !probeSourcesPending(db)) { windows(); return; }
  ensureProbeReaderSchema(db);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  const options = { declarations: sources, archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN };
  const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  for (const declaration of sources) {
    const source = probeArchiveSourceOf({ provider: declaration.vendor, machine: declaration.machine,
      login: declaration.login, source_home: declaration.source_home }, options);
    if (!source) throw new Error(`Fixture source did not resolve: ${declaration.vendor}/${declaration.id}`);
    // Existing explicit periods are authoritative: fixture rows may intentionally reuse a
    // physical source across account handovers, so the declaration ID must never overwrite them.
    if (!periods.some(period => period.provider === declaration.vendor && period.subject.toLowerCase() === source.toLowerCase())) {
      periods.push({ provider: declaration.vendor, subject: source, value: declaration.id,
        from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
        readings: 0, evidence: "probe-reader-fixture" });
    }
  }
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);

  const rows = db.query("SELECT * FROM probe_windows ORDER BY id").all() as Array<Record<string, unknown> &
    ProbeReaderFixtureRow & { machine: string | null }>;
  for (const row of rows) {
    const owner = accountForRow(row);
    const declaration = sources.find(candidate => candidate.vendor === row.provider
      && candidate.id.toLowerCase() === (owner ?? "").toLowerCase());
    if (!declaration) continue;
    if (!row.machine) {
      db.query("UPDATE probe_windows SET machine=? WHERE id=?").run(declaration.machine, row.id);
    }
    const current = db.query("SELECT * FROM probe_windows WHERE id=?").get(row.id) as Record<string, unknown>;
    const fact = createProbeCollection([{ ...current, raw_subject: null, login: declaration.login,
      source_home: declaration.source_home }])[0]!;
    db.transaction(() => {
      acceptProbeFact(db, fact);
      mapProbeLegacy(db, fact, row.id, "fixture-linked-physical-source");
    }).immediate();
  }

  // Keep caller metadata separate while publishing the physical coordinates actually
  // synthesized above; those coordinates also identify the canonical facts we linked.
  const now = new Date().toISOString(), config = splitProbeReaderFixtureConfig([...declarations, ...sources]),
    registry = currentRegistry(config.subscriptions, now);
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (!publishCurrentBatch(db, registry, now, 32, config)) {
      if (!preparedProbeAccountIndexReady(db)) throw new Error("Fixture probe account index did not become ready");
      windows();
      return;
    }
  }
  throw new Error("Fixture current projection did not settle");
}
