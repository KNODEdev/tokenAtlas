import fs from "fs";
import { scanCodexProfiles } from "../providers/codex-identity";
import { scanVendorProfiles } from "../providers/vendor-identity";
import { digest } from "../config/canonical-json";
import { readAccountsDocument } from "../config/accounts-document";
import { readAccountsV2 } from "../config/accounts-document";
import { parseAccountsV2, type SourceV2, type SubscriptionV2 } from "../config/accounts-v2";
import path from "path";
import {
  ARCHIVE_ROOT,
  ARCHIVE_ROOT_IS_EXPLICIT,
  CONFIG_ROOT,
  CONFIG_ROOT_IS_EXPLICIT,
  resolveArchiveRootFromEnv,
  resolveConfigRootFromEnv,
  LOGIN,
  MACHINE,
  PRIVATE_CONFIG_FILES,
  PROFILE,
  REPO_ROOT,
  archiveProfiles,
  atlasIndexSnapshotPool,
  configFile,
  configWriteTarget,
  conflictCopies,
  expandPath,
  home,
} from "../config/paths";
import { resolveDbPath } from "../db";
import { temporaryDirectory } from "../config/temporary-storage";
import { bindArchiveIdentity, prepareArchiveConnection, type ArchiveConnectionAction } from "../config/archive-location";
import {
  localArchiveLocatorPath,
  persistLocalArchiveSelection,
  readLocalArchiveSelection,
  validateLocalArchiveLocatorState,
  validateLocalArchiveSelection,
} from "../config/archive-locator";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { withArchiveFileWriter } from "../sync/archive-writers";
import { Database } from "../db/sqlite";
import { loadAccountResolver } from "./account-resolver";
import { archiveFolderOf } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
const LIVE_SOURCES: Array<{ vendor: string; probe: () => string }> = [
  { vendor: "codex", probe: () => home(".codex", "sessions") },
  { vendor: "claude", probe: () => home(".claude", "projects") },
  { vendor: "grok", probe: () => home(".grok", "sessions") },
  { vendor: "gemini", probe: () => home(".gemini", "antigravity-cli", "conversations") },
  { vendor: "opencode", probe: () => home(".local", "share", "opencode", "opencode.db") },
];
export interface SuggestedSubscription {
  id: string;
  vendor: string;
  machine: string;
  login: string;
  home: string;
  source_home?: string;
  account?: string;
  from?: string;
  until?: string;
  note?: string;
  found_in: "archive" | "live" | "declared";
  is_this_machine: boolean;
  merged_from_login: boolean;
}
interface DeclaredSubscription {
  id: string;
  vendor?: string;
  machine?: string;
  login?: string;
  home: string;
  source_home?: string;
  account?: string;
  from?: string;
  until?: string;
  note?: string;
  [extra: string]: unknown;
}
function readDeclaredSubscriptions(file: string): DeclaredSubscription[] {
  if (!safeExists(file)) return [];
  const cfg = parseAccountsV2(JSON.parse(fs.readFileSync(file, "utf-8")));
  return cfg.sources.map(source => ({ ...source, id: "" }));
}
function homeKey(raw: string): string {
  try {
    return expandPath(raw).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
}
export interface SetupState {
  profiles: Array<{ vendor: string; home: string; account: string | null; error: string | null }>;
  configured: boolean;
  reason: string | null;
  machine: string;
  login: string;
  profile: string;
  archive: {
    root: string;
    explicit: boolean;
    exists: boolean;
    vendors: Array<{ vendor: string; profiles: string[] }>;
  };
  config: {
    root: string;
    explicit: boolean;
    exists: boolean;
    present: string[];
    missing: string[];
    conflicts: string[];
  };
  snapshot: {
    root: string;
    explicit: boolean;
    exists: boolean;
    database: string;
  };
  temporary: { root: string; exists: boolean };
  live: Array<{ vendor: string; path: string; exists: boolean }>;
  suggestion: SuggestedSubscription[];
  notes: string[];
}
function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function accountsDeclared(): { ok: boolean; file: string; count: number } {
  const file = configFile("accounts.json");
  if (!safeExists(file)) return { ok: false, file, count: 0 };
  try {
    const cfg = parseAccountsV2(JSON.parse(fs.readFileSync(file, "utf-8")));
    return { ok: true, file, count: cfg.subscriptions.length };
  } catch {
    return { ok: false, file, count: 0 };
  }
}
function splitProfile(profile: string): { machine: string; login: string } {
  const i = profile.lastIndexOf("-");
  if (i <= 0) return { machine: profile, login: "" };
  return { machine: profile.slice(0, i), login: profile.slice(i + 1) };
}
function isProfileDir(name: string): boolean {
  return !name.startsWith("_") && name.includes("-");
}
export function suggestSubscriptions(database = resolveDbPath()): SuggestedSubscription[] {
  // Re-runs of the wizard (Settings → Maszyna) must start from what is already
  // declared, or a save would replace hand-curated accounts.json with a bare scan.
  const declared = readDeclaredSubscriptions(configFile("accounts.json"));
  if (safeExists(database) && safeExists(configFile("accounts.json"))) {
    const sqlite = new Database(database,{readonly:true});
    try {
      const metadata = readAccountsV2(configFile("accounts.json")).subscriptions;
      const resolver = loadAccountResolver(sqlite,metadata);
      const now = new Date().toISOString();
      for (const source of declared) {
        const folder = archiveFolderOf(expandPath(source.home), ARCHIVE_LOGICAL_ROOT)?.key;
        const owner = folder ? resolver.resolve(source.vendor ?? "codex",folder,null,now).account : null;
        if (!owner) continue;
        source.id = owner;
        const account = metadata.find(row => row.id.toLowerCase() === owner);
        if (account?.account) source.account = account.account;
      }
    } catch (error) {
      if (!/no such table: account_periods/i.test(String(error))) throw error;
    } finally { sqlite.close(); }
  }
  const declaredHomes = new Set(declared.map((d) => homeKey(d.home)));
  const out: SuggestedSubscription[] = declared.map((d) => ({
    id: d.id,
    vendor: d.vendor ?? "codex",
    machine: d.machine ?? "",
    login: d.login ?? "",
    home: d.home,
    ...(d.source_home ? { source_home: d.source_home } : {}),
    ...(d.account ? { account: d.account } : {}),
    ...(d.from ? { from: d.from } : {}),
    ...(d.until ? { until: d.until } : {}),
    ...(d.note ? { note: d.note } : {}),
    found_in: "declared",
    is_this_machine: `${d.machine ?? ""}-${d.login ?? ""}` === PROFILE,
    merged_from_login: false,
  }));
  const profiles = archiveProfiles("codex").filter(isProfileDir);
  const live = safeExists(home(".codex", "sessions"));
  if (!profiles.includes(PROFILE) && live) profiles.push(PROFILE);
  const ordered = [...profiles.filter((p) => p === PROFILE), ...profiles.filter((p) => p !== PROFILE)].filter(
    (profile) => !declaredHomes.has(homeKey(`\${ARCHIVE}/codex/${profile}`))
  );
  const idByLogin = new Map<string, string>();
  const usedIds = new Set(declared.map((d) => d.id.toLowerCase()));
  for (const d of declared) {
    if ((d.vendor ?? "codex") !== "codex" || !d.login) continue;
    const key = d.login.toLowerCase();
    if (!idByLogin.has(key)) idByLogin.set(key, d.id);
  }
  let nextN = 1;
  const freshId = () => {
    while (usedIds.has(`codex${nextN}`)) nextN += 1;
    const id = `codex${nextN}`;
    usedIds.add(id);
    return id;
  };
  for (const profile of ordered) {
    const { machine, login } = splitProfile(profile);
    const isMine = profile === PROFILE;
    const loginKey = login.toLowerCase();
    let id = idByLogin.get(loginKey);
    const merged = id != null;
    if (!id) {
      id = freshId();
      idByLogin.set(loginKey, id);
    }
    out.push({
      id,
      vendor: "codex",
      machine,
      login,
      home: `\${ARCHIVE}/codex/${profile}`,
      ...(isMine ? { source_home: "~/.codex" } : {}),
      found_in: profiles.includes(profile) && !(isMine && !archiveProfiles("codex").includes(PROFILE)) ? "archive" : "live",
      is_this_machine: isMine,
      merged_from_login: merged,
    });
  }
  return out;
}
export function buildSetupStatus(): Pick<SetupState, "configured"> {
  return { configured: safeExists(ARCHIVE_ROOT) && accountsDeclared().ok };
}

export function buildSetupState(database: string = resolveDbPath()): SetupState {
  const accounts = accountsDeclared();
  const archiveExists = safeExists(ARCHIVE_ROOT);
  const configExists = safeExists(CONFIG_ROOT);
  const snapshotRoot = atlasIndexSnapshotPool(database);
  const temporaryRoot = temporaryDirectory(database);
  const vendors = ["codex", "claude", "gemini", "grok", "opencode"]
    .map((vendor) => ({ vendor, profiles: archiveProfiles(vendor) }))
    .filter((v) => v.profiles.length > 0);
  const present: string[] = [];
  const missing: string[] = [];
  const conflicts: string[] = [];
  for (const name of PRIVATE_CONFIG_FILES) {
    if (safeExists(path.join(CONFIG_ROOT, name))) present.push(name);
    else missing.push(name);
    conflicts.push(...conflictCopies(name).map((p) => path.basename(p)));
  }
  const notes: string[] = [];
  for (const profile of scanCodexProfiles({ machine: MACHINE })) {
    notes.push(`ChatGPT · ${profile.machine} / ${profile.login}: ${profile.identity?.email ?? profile.identity?.account_id ?? profile.error}. ` +
      (profile.identity ? "Konto jest wykrywane automatycznie. Poniższe deklaracje dotyczą historii sesji." : "Odczyt wymaga dostępu do tego profilu Windows."));
  }
  for (const profile of scanVendorProfiles({machine:MACHINE})) {
    notes.push(`${profile.surface} · ${profile.machine} / ${profile.login}: ${profile.email ?? profile.error ?? "Unknown account"}. ${profile.email && profile.error ? profile.error : ""}`);
  }
  let reason: string | null = null;
  if (!archiveExists) {
    reason = `Archiwum nie istnieje pod ${ARCHIVE_ROOT}. To z niego czytane sa wszystkie transkrypty, wiec bez niego nie ma czego liczyc.`;
  } else if (!accounts.ok) {
    reason =
      vendors.some((v) => v.vendor === "codex")
        ? "Archiwum ma rollouty Codeksa, ale zadna subskrypcja nie jest zadeklarowana. Rollouty nie niosa identyfikatora konta, wiec przypisanie musi byc recznie potwierdzone."
        : "Brak accounts.json. Nawet bez Codeksa plik musi istniec, zeby aplikacja wiedziala, ze pytanie zostalo zadane i zamkniete.";
  }
  if (conflicts.length > 0) {
    notes.push(
      `OneDrive zostawil kopie konfliktowe: ${conflicts.join(", ")}. Aplikacja czyta wersje podstawowa i NIE scala ich sama - porownaj je i usun zbedna, inaczej czesc regul zniknie bez sladu.`
    );
  }
  if (!ARCHIVE_ROOT_IS_EXPLICIT && !readLocalArchiveSelection() && !archiveExists) {
    notes.push(
      "Sciezka archiwum jest zgadywana z %OneDrive%. Jesli archiwum lezy gdzie indziej, wybierz je jawnie - wybor zostanie zapisany lokalnie dla tej maszyny."
    );
  }
  if (accounts.ok && accounts.count === 0) {
    notes.push("accounts.json istnieje, ale nie deklaruje zadnej subskrypcji - ekrany Codeksa zostana puste.");
  }
  return {
    profiles: [
      ...scanCodexProfiles({ machine: MACHINE }).map(p => ({ vendor: "codex", home: p.home, account: p.identity?.email ?? null, error: p.error })),
      ...scanVendorProfiles({ machine: MACHINE, pool: [] }).filter(p => p.vendor === "claude")
        .map(p => ({ vendor: p.vendor, home: p.home, account: p.email, error: p.error })),
    ],
    configured: archiveExists && accounts.ok,
    reason,
    machine: MACHINE,
    login: LOGIN,
    profile: PROFILE,
    archive: { root: ARCHIVE_ROOT, explicit: ARCHIVE_ROOT_IS_EXPLICIT, exists: archiveExists, vendors },
    config: {
      root: CONFIG_ROOT,
      explicit: CONFIG_ROOT_IS_EXPLICIT,
      exists: configExists,
      present,
      missing,
      conflicts,
    },
    snapshot: {
      root: snapshotRoot,
      explicit: Boolean(process.env.TOKENATLAS_SNAPSHOT_DIR?.trim()),
      exists: safeExists(snapshotRoot),
      database,
    },
    temporary: { root: temporaryRoot, exists: safeExists(temporaryRoot) },
    live: LIVE_SOURCES.map(({ vendor, probe }) => {
      const p = probe();
      return { vendor, path: p, exists: safeExists(p) };
    }),
    suggestion: suggestSubscriptions(database),
    notes,
  };
}
export interface SetupSaveInput {
  expectedSourceRevision?: string;
  archive?: string | null;
  archiveAction?: ArchiveConnectionAction;
  config?: string | null;
  snapshot?: string | null;
  sources?: SourceV2[];
  subscriptions?: Array<{
    id: string;
    vendor?: string;
    machine?: string;
    login?: string;
    home: string;
    source_home?: string;
    account?: string;
    from?: string;
    until?: string;
    note?: string;
  }>;
}
export interface SetupSaveResult {
  ok: true;
  wrote: string[];
  restart_required: boolean;
  restart_reason: string | null;
}
export class InheritedConfigRootError extends Error {
  readonly variable = "TOKENATLAS_CONFIG" as const;
  readonly inherited: string;
  readonly requested: string;
  constructor(inherited: string, requested: string) {
    super(
      `TOKENATLAS_CONFIG is inherited as '${inherited}' and Bun will not let .env replace it. ` +
        `This save would write accounts under '${requested}', which the next process would not read. ` +
        `Set TOKENATLAS_CONFIG to '${requested}' in the process environment (not .env) and retry.`
    );
    this.name = "InheritedConfigRootError";
    this.inherited = inherited;
    this.requested = requested;
  }
}
function setupRootsFor(
  input: Pick<SetupSaveInput, "archive" | "config" | "snapshot">,
  database: string = resolveDbPath()
): {
  archiveRaw: string;
  configRaw: string;
  snapshotRaw: string;
  archiveRoot: string;
  configRoot: string;
  snapshotRoot: string;
} {
  const archiveRaw = (input.archive ?? "").trim();
  const configRaw = (input.config ?? "").trim();
  const snapshotRaw = (input.snapshot ?? "").trim();
  const archiveRoot = archiveRaw ? path.resolve(archiveRaw) : ARCHIVE_ROOT;
  const configRoot = configRaw
    ? path.resolve(configRaw)
    : archiveRaw
      ? path.join(archiveRoot, "config")
      : CONFIG_ROOT;
  const snapshotEnv = {
    ...process.env,
    ...(archiveRaw ? { TOKENATLAS_ARCHIVE: archiveRaw } : {}),
    ...(snapshotRaw ? { TOKENATLAS_SNAPSHOT_DIR: snapshotRaw } : {}),
  };
  const snapshotRoot = atlasIndexSnapshotPool(database, snapshotEnv);
  return { archiveRaw, configRaw, snapshotRaw, archiveRoot, configRoot, snapshotRoot };
}
function rootKey(root: string): string {
  return path.resolve(root).replace(/\\/g, "/").toLowerCase();
}
export function assertConfigRootNotShadowed(
  input: Pick<SetupSaveInput, "archive" | "config">
): void {
  const inherited = process.env.TOKENATLAS_CONFIG?.trim();
  if (!inherited) return;
  const { configRoot } = setupRootsFor(input);
  const live = resolveConfigRootFromEnv(process.env);
  if (rootKey(live) !== rootKey(configRoot)) {
    throw new InheritedConfigRootError(live, configRoot);
  }
}
export class InheritedArchiveRootError extends Error {
  readonly variable = "TOKENATLAS_ARCHIVE" as const;
  constructor(readonly inherited: string, readonly requested: string) {
    super(`TOKENATLAS_ARCHIVE is inherited as '${inherited}' and overrides '${requested}'. Change the process environment setting before connecting another directory. / Zmień TOKENATLAS_ARCHIVE w konfiguracji procesu przed podłączeniem innego katalogu.`);
    this.name = "InheritedArchiveRootError";
  }
}
export function assertArchiveRootNotShadowed(input: Pick<SetupSaveInput,"archive">): void {
  if (!input.archive?.trim() || !process.env.TOKENATLAS_ARCHIVE?.trim()) return;
  if (rootKey(resolveArchiveRootFromEnv(process.env)) !== rootKey(input.archive))
    throw new InheritedArchiveRootError(resolveArchiveRootFromEnv(process.env), path.resolve(input.archive));
}
export function setupArchiveRootsToCheck(
  input: Pick<SetupSaveInput, "archive" | "config">,
  database: string = resolveDbPath()
): string[] {
  const { archiveRoot } = setupRootsFor(input, database);
  const inheritedRoot = resolveArchiveRootFromEnv(process.env);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of [archiveRoot, inheritedRoot]) {
    const k = rootKey(root);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(root);
  }
  return out;
}
interface SetupPersistTargets {
  envFile?: string;
  sqlite?: import("bun:sqlite").Database;
  dbPath?: string;
}
export function saveSetup(input: SetupSaveInput, persist: SetupPersistTargets = {}): SetupSaveResult {
  const wrote: string[] = [];
  const envLines: string[] = [];
  const database = persist.dbPath ?? resolveDbPath();
  const { archiveRaw, configRaw, snapshotRaw, archiveRoot, configRoot, snapshotRoot } = setupRootsFor(
    input,
    database
  );
  assertConfigRootNotShadowed(input);
  assertArchiveRootNotShadowed(input);
  temporaryDirectory(database, { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot,
    TOKENATLAS_CONFIG: configRoot, TOKENATLAS_SNAPSHOT_DIR: snapshotRoot });
  if ([archiveRaw,configRaw,snapshotRaw].some(value=>/[\r\n\0]/.test(value))) throw new Error("Directory paths cannot contain line breaks");
  // Fail a corrupt pre-existing locator before setup creates an archive or writes configuration.
  validateLocalArchiveLocatorState(process.env);
  // Archive selection is durable in the local locator. A launcher .env archive hint
  // would outrank it and could point at a new root while locator publication failed.
  if (configRaw && rootKey(configRoot) !== rootKey(resolveConfigRootFromEnv(process.env))) {
    envLines.push(`TOKENATLAS_CONFIG=${configRaw}`);
  }
  if (snapshotRaw && rootKey(snapshotRoot) !== rootKey(atlasIndexSnapshotPool(database))) {
    envLines.push(`TOKENATLAS_SNAPSHOT_DIR=${snapshotRaw}`);
  }
  const envFile = envLines.length > 0 || (archiveRaw && persist.envFile) ? persist.envFile : undefined;
  if (envLines.length > 0 && !envFile) {
    throw new Error("saveSetup requires an explicit envFile when setup changes environment roots");
  }
  if (
    envFile &&
    process.env.NODE_ENV === "test" &&
    rootKey(envFile) === rootKey(path.join(REPO_ROOT, ".env"))
  ) {
    throw new Error("tests may not write the repository .env; pass a fixture envFile");
  }
  if (input.archiveAction === "connect") {
    const existingAccounts = path.join(configRoot, "accounts.json");
    if (!safeExists(existingAccounts)) throw new Error("The existing archive has no account configuration; choose its configuration directory");
    readAccountsDocument(existingAccounts);
  }
  const archiveConnection = archiveRaw ? prepareArchiveConnection(archiveRoot,
    input.archiveAction ?? (safeExists(archiveRoot) ? "connect" : "create"),
    {database,currentRoot:ARCHIVE_ROOT,sqlite:persist.sqlite}) : undefined;
  const locatorEnvironment = {
    ...process.env,
    ...(configRaw ? { TOKENATLAS_CONFIG: configRoot } : {}),
  };
  if (archiveConnection) validateLocalArchiveSelection(archiveConnection, locatorEnvironment, true);
  const archiveSelectionChanged = Boolean(archiveConnection
    && rootKey(archiveConnection.root) !== rootKey(ARCHIVE_ROOT));
  let environmentChanged = false;
  const saveEnvironment = () => {
    if (!envFile) return;
    const existing = safeExists(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
    const marker = "# Ustawione przez kreator pierwszego uruchomienia.";
    const replaced = new Set(envLines.map(next=>next.split("=")[0]));
    if (archiveRaw) replaced.add("TOKENATLAS_ARCHIVE");
    const kept = existing.split(/\r?\n/).filter(line=>line.trim()!==marker)
      .filter(line=>!replaced.has(line.trim().split("=")[0]!)).join("\n").trimEnd();
    const managed = envLines.length ? "\n"+marker+"\n"+envLines.join("\n")+"\n" : "\n";
    const next = (kept ? kept+"\n" : "")+managed;
    if (next === existing) return;
    atomicArchiveWrite(envFile,next);
    wrote.push(envFile);
    environmentChanged = true;
  };
  const publishArchiveConnection = () => {
    if (!archiveConnection) return;
    const meta = persist.sqlite?.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
    const previous = meta ? persist.sqlite!.query("SELECT value FROM meta WHERE key='archive:identity'").get() as {value:string}|null : null;
    bindArchiveIdentity(persist.sqlite,archiveConnection.archiveId);
    try {
      const published = persistLocalArchiveSelection(archiveConnection, locatorEnvironment);
      if (published.changed) wrote.push(localArchiveLocatorPath(locatorEnvironment));
    } catch (error) {
      if (meta) {
        try {
          if (previous) persist.sqlite!.query("INSERT INTO meta(key,value) VALUES('archive:identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(previous.value);
          else persist.sqlite!.query("DELETE FROM meta WHERE key='archive:identity'").run();
        } catch (rollbackError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; archive identity rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      throw error;
    }
  };
  if (input.archiveAction === "connect" && archiveConnection) {
    // Connection never merges the current wizard's declarations into the target archive.
    saveEnvironment();
    publishArchiveConnection();
    const restartRequired = archiveSelectionChanged || environmentChanged;
    return {ok:true,wrote,restart_required:restartRequired,restart_reason:restartRequired
      ? "Archiwum podłączone. Uruchom aplikację ponownie, aby użyć wybranej lokalizacji.":null};
  }
  const targetConfigRoot = configRoot;
  const accountsFile = path.join(targetConfigRoot, "accounts.json");
  const targetDocument = readAccountsDocument(accountsFile);
  if (input.expectedSourceRevision && digest(targetDocument) !== input.expectedSourceRevision)
    throw new Error("Konfiguracja zmieniła się. Zamknij edytor i otwórz go ponownie.");
  const previous = readDeclaredSubscriptions(accountsFile);
  const requestedSources = input.sources ?? (input.subscriptions ?? []).map(sub => ({...sub,vendor:sub.vendor ?? "codex"}));
  for (const definition of requestedSources) {
    const prev = previous.find(source => source.vendor === definition.vendor && homeKey(source.home) === homeKey(definition.home));
    if (!definition.source_home || definition.source_home === prev?.source_home) continue;
    const vendor = definition.vendor;
    if (!["codex", "claude", "grok", "gemini"].includes(vendor)) continue;
    const source = expandPath(definition.source_home);
    if (!path.isAbsolute(source) || !fs.statSync(source).isDirectory()) throw new Error("Profile must be an existing absolute directory");
    const destination = expandPath(definition.home, { archive: archiveRoot });
    const sourceKey = homeKey(source), destinationKey = homeKey(destination);
    if (sourceKey === destinationKey || sourceKey.startsWith(destinationKey + "/") || destinationKey.startsWith(sourceKey + "/")) {
      throw new Error("Profile and archive directories must not contain each other");
    }
  }
  const subscriptions = [...targetDocument.subscriptions as SubscriptionV2[]];
  for (const row of input.subscriptions ?? []) {
    if (!row.id.trim()) continue;
    const vendor = row.vendor ?? "codex";
    const existing = subscriptions.find(sub => sub.id.toLowerCase() === row.id.toLowerCase() && sub.vendor === vendor);
    if (!existing) subscriptions.push({ id: row.id, vendor, ...(row.account ? { account: row.account } : {}),
      ...(row.note ? { note: row.note } : {}) });
  }
  const sources = input.sources ?? (input.subscriptions
    ? input.subscriptions.map(row => ({ vendor: row.vendor ?? "codex", home: row.home,
      ...(row.machine ? { machine: row.machine } : {}), ...(row.login ? { login: row.login } : {}),
      ...(row.source_home ? { source_home: row.source_home } : {}) }))
    : targetDocument.sources as SourceV2[]);
  const body = parseAccountsV2({ ...targetDocument, version: 2, subscriptions, sources });
  withArchiveFileWriter(accountsFile, () => {
    if (!safeExists(targetConfigRoot)) fs.mkdirSync(targetConfigRoot, { recursive: true });
    atomicArchiveWrite(accountsFile, JSON.stringify(body, null, 2) + "\n");
  });
  wrote.push(accountsFile);
  saveEnvironment();
  publishArchiveConnection();
  const restartRequired = archiveSelectionChanged || environmentChanged;
  return {
    ok: true,
    wrote,
    restart_required: restartRequired,
    restart_reason: restartRequired
      ? "Sciezki i lokalny wybor archiwum sa czytane raz, przy starcie - uruchom _dev.bat ponownie."
      : null,
  };
}
