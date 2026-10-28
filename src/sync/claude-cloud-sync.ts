import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../config/canonical-json";
import { localStateRoot } from "../config/local-identity";
import { ARCHIVE_ROOT, configFile, requireArchiveRoot } from "../config/paths";
import { createTemporaryWorkspace } from "../config/temporary-storage";
import { resolveDbPath } from "../db";
import { loadProjects, type ProjectsConfig } from "../projects/remap";
import { readClaudeCredentials, readClaudeTrustedDevice, refreshFailure } from "../providers/adapters/claude";
import { claudeTokenDue, refreshableProfileHome, refreshClaudeCredentials } from "../providers/adapters/claude-token-refresh";
import { publishArchiveFile } from "./archive-publication";
import { CloudApiError, defaultCloudGet, listCloudSessions, readCloudEvents, readCloudOwner, type CloudAuth, type CloudGet } from "./claude-cloud-api";
import { cloudPlaces, localRepositories, type CloudRepositoryConfig } from "./claude-cloud-places";
import { profileMirrorTargets } from "./mirror";

/**
 * Claude cloud sessions → archive (docs/cloud-sessions-import-2026-10-23.md, decision 5).
 * Each changed session is rebuilt in a temporary workspace (its archived file plus the new events),
 * checked, and only then published with the archive's own append-only publication. The archive
 * folder is `<profile archive>-cloud`; parsing picks it up like files written by another computer.
 */
export const CLOUD_ENVIRONMENT = "anthropic_cloud";
const STATE_FILE = "claude-cloud-sync.json";
const REPOSITORY_CONFIG = "cloud-repositories.json";
/** Session fields worth keeping; `environment_variables` and `mcp_config` may hold secrets and are never archived. */
const SESSION_FIELDS = ["id", "title", "type", "environment_kind", "environment_id", "created_at", "session_status", "tags"] as const;
const CONTEXT_FIELDS = ["cwd", "model", "effort_level", "permission_mode", "sources", "outcomes"] as const;

export interface CloudProfile { sourceHome: string; archiveDir: string }
interface SessionCheckpoint { updated_at: string; sequence: number; cursor: string | null }
interface SyncState { schema: 1; profiles: Record<string, { sessions: Record<string, SessionCheckpoint> }> }
export interface CloudProfileResult { archiveDir: string; sessions: number; changed: number; published: number; errors: string[] }
export interface CloudSyncResult { startedAt: string; finishedAt: string; profiles: CloudProfileResult[]; archived: string[] }
export interface CloudSyncOptions {
  get?: CloudGet;
  profiles?: CloudProfile[];
  archiveRoot?: string;
  stateRoot?: string;
  workspace?: () => { directory: string; dispose: () => void };
  projects?: () => ProjectsConfig;
  repositories?: () => CloudRepositoryConfig;
  auth?: (profile: CloudProfile) => Promise<CloudAuth>;
  now?: () => Date;
}

/** One cloud folder per Claude profile this computer mirrors (`EXAMPLE-MAIN-cloud`, `EXAMPLE-MAIN-sample_a-claude-2-cloud`). */
export function cloudProfiles(): CloudProfile[] {
  return profileMirrorTargets("claude", []).map(target => ({
    sourceHome: path.dirname(target.source), archiveDir: `${target.destination}-cloud`,
  }));
}

async function profileAuth(profile: CloudProfile): Promise<CloudAuth> {
  const home = profile.sourceHome;
  let { creds, error } = readClaudeCredentials(home);
  if (!creds) throw new Error(error ?? "no Claude login in this profile");
  // The same refresh the account probes use, only for a profile on this machine's own disk.
  if (claudeTokenDue(creds.expires_at) && refreshableProfileHome(home)) {
    const outcome = await refreshClaudeCredentials({ home, usedToken: creds.token });
    if (outcome.status === "refreshed") creds = readClaudeCredentials(home).creds ?? creds;
    else if (outcome.status === "failed" && (creds.expires_at ?? 0) <= Date.now())
      throw refreshFailure(outcome.failure);
  }
  return { token: creds.token, trustedDevice: readClaudeTrustedDevice(home) };
}

function readState(root: string): SyncState {
  const file = path.join(root, STATE_FILE);
  if (!fs.existsSync(file)) return { schema: 1, profiles: {} };
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
  if (state?.schema !== 1 || typeof state.profiles !== "object") throw new Error("Invalid cloud session checkpoint state.");
  return state;
}
function writeState(root: string, state: SyncState): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, STATE_FILE), candidate = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(candidate, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
}
const profileKey = (profile: CloudProfile) => path.resolve(profile.archiveDir).replaceAll("\\", "/").toLowerCase();

/** The last complete record of a JSONL file, read from its end. */
export function lastJsonlRecord(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - 65_536);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      tail = Buffer.concat([chunk, tail]);
      end = start;
      const body = tail.subarray(0, tail.length - (tail.at(-1) === 0x0a ? 1 : 0));
      const at = body.lastIndexOf(0x0a);
      if (at >= 0 || start === 0) {
        const line = body.subarray(at + 1).toString("utf8").trim();
        return line ? JSON.parse(line) as Record<string, unknown> : null;
      }
    }
    return null;
  } finally { fs.closeSync(fd); }
}

const sequenceOf = (event: Record<string, unknown>): number => {
  const value = Number(event.sequence_num);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`event without a valid sequence_num: ${String(event.event_id)}`);
  return value;
};

/**
 * The events to append after the archived end: consecutive `sequence_num` values, no gaps or repeats.
 * A read without a cursor starts from the first event, so the archived ones are skipped after checking
 * that the archived end is the same event.
 */
export function eventsToAppend(events: Array<Record<string, unknown>>, archived: Record<string, unknown> | null,
  resumed: boolean): Array<Record<string, unknown>> {
  const known = archived ? sequenceOf(archived) : 0;
  let expected = known + 1;
  const fresh: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (typeof event?.event_id !== "string" || !event.event_id) throw new Error("event without an event_id");
    const sequence = sequenceOf(event);
    if (sequence < expected) {
      if (resumed || fresh.length) throw new Error(`event ${sequence} repeated after ${expected - 1}`);
      if (sequence === known && event.event_id !== archived!.event_id)
        throw new Error(`event ${sequence} differs from the archived one`);
      continue;
    }
    if (sequence !== expected) throw new Error(`events ${expected}..${sequence - 1} are missing`);
    fresh.push(event);
    expected++;
  }
  return fresh;
}

/**
 * The session as archived next to its events: stable fields, the declared places and the owner
 * (the account whose token listed it; the parser's session identity), no secrets.
 */
export function sessionDeclaration(session: Record<string, unknown>, places: ReturnType<typeof cloudPlaces>,
  owner: string): Record<string, unknown> {
  const context = (session.session_context ?? {}) as Record<string, unknown>;
  return {
    schema: 1,
    session: Object.fromEntries(SESSION_FIELDS.filter(key => key in session).map(key => [key, session[key]])),
    context: Object.fromEntries(CONTEXT_FIELDS.filter(key => key in context).map(key => [key, context[key]])),
    places,
    owner: { account_key: owner },
  };
}

/** Archived copy + new records → checked temporary file → archive publication. */
function publishGrowth(destination: string, records: readonly unknown[], provenance: string,
  archive: { archiveRoot: string; localStateRoot?: string }, workspace: () => { directory: string; dispose: () => void }): void {
  const work = workspace();
  try {
    const staging = path.join(work.directory, path.basename(destination));
    if (fs.existsSync(`${destination}.zst`)) throw new Error(`compressed cloud archive is not supported: ${destination}`);
    if (fs.existsSync(destination)) fs.copyFileSync(destination, staging);
    fs.appendFileSync(staging, records.map(record => JSON.stringify(record) + "\n").join(""));
    publishArchiveFile(staging, destination, { ...archive, jsonl: true, provenance });
  } finally { work.dispose(); }
}

export async function syncClaudeCloudSessions(options: CloudSyncOptions = {}): Promise<CloudSyncResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const archiveRoot = options.archiveRoot ?? (requireArchiveRoot(), ARCHIVE_ROOT);
  const stateRoot = options.stateRoot ?? localStateRoot();
  const get = options.get ?? defaultCloudGet;
  const workspace = options.workspace ?? (() => createTemporaryWorkspace("cloud-sync", resolveDbPath()));
  const state = readState(stateRoot);
  // Tests give one local-state folder for both the checkpoints and the publication records.
  const archive = { archiveRoot, ...(options.stateRoot ? { localStateRoot: options.stateRoot } : {}) };
  const result: CloudSyncResult = { startedAt, finishedAt: startedAt, profiles: [], archived: [] };
  let clones: Map<string, string[]> | undefined;
  let repositories: CloudRepositoryConfig | undefined;
  const places = (sources: unknown) => {
    clones ??= localRepositories((options.projects ?? (() => loadProjects()))());
    repositories ??= (options.repositories ?? readRepositoryConfig)();
    return cloudPlaces(sources, clones, repositories);
  };
  for (const profile of options.profiles ?? cloudProfiles()) {
    const outcome: CloudProfileResult = { archiveDir: profile.archiveDir, sessions: 0, changed: 0, published: 0, errors: [] };
    result.profiles.push(outcome);
    let auth: CloudAuth, sessions: Array<Record<string, unknown>>, owner: string;
    try {
      auth = await (options.auth ?? profileAuth)(profile);
      sessions = (await listCloudSessions(get, auth)).filter(session => session.environment_kind === CLOUD_ENVIRONMENT);
      owner = await readCloudOwner(get, auth);
    } catch (error) { outcome.errors.push(describe(error)); continue; }
    outcome.sessions = sessions.length;
    if (sessions.length && !auth.trustedDevice) {
      outcome.errors.push("session history needs a trusted device: run /login in this Claude Code profile to renew its device credential");
      continue;
    }
    const checkpoints = (state.profiles[profileKey(profile)] ??= { sessions: {} }).sessions;
    for (const session of sessions) {
      const id = session.id as string, updatedAt = String(session.updated_at ?? "");
      if (!/^[A-Za-z0-9_-]+$/.test(id)) { outcome.errors.push(`unexpected session id: ${id.slice(0, 60)}`); continue; }
      const eventsFile = path.join(profile.archiveDir, `${id}.events.jsonl`);
      const sessionFile = path.join(profile.archiveDir, `${id}.session.jsonl`);
      const checkpoint = checkpoints[id];
      try {
        // The declaration first, and in every run: events are never archived without the places and owner that
        // interpret them, and a changed declaration (a new clone, alias or owner) makes the parser read them again.
        const declaration = sessionDeclaration(session, places((session.session_context as Record<string, unknown> | undefined)?.sources), owner);
        const declared = lastJsonlRecord(sessionFile);
        if (!declared || canonicalJson(declared) !== canonicalJson(declaration)) {
          publishGrowth(sessionFile, [declaration], path.join(profile.sourceHome, "cloud-sessions", path.basename(sessionFile)), archive, workspace);
          result.archived.push(sessionFile);
        }
        if (checkpoint?.updated_at === updatedAt && fs.existsSync(eventsFile)) continue;
        outcome.changed++;
        const archived = lastJsonlRecord(eventsFile);
        // A cursor belongs to the archived end it was issued for; otherwise the read starts over.
        const cursor = archived && checkpoint?.cursor && checkpoint.sequence === sequenceOf(archived) ? checkpoint.cursor : null;
        const read = await readCloudEvents(get, auth, id, cursor);
        const fresh = eventsToAppend(read.events, archived, cursor !== null);
        if (fresh.length) {
          publishGrowth(eventsFile, fresh, path.join(profile.sourceHome, "cloud-sessions", path.basename(eventsFile)), archive, workspace);
          result.archived.push(eventsFile);
          outcome.published++;
        }
        const end = fresh.at(-1) ?? archived;
        checkpoints[id] = { updated_at: updatedAt, sequence: end ? sequenceOf(end) : 0, cursor: read.resumeCursor };
        writeState(stateRoot, state);
      } catch (error) { outcome.errors.push(`${id}: ${describe(error)}`); }
    }
  }
  result.finishedAt = now().toISOString();
  return result;
}

function readRepositoryConfig(): CloudRepositoryConfig {
  const file = configFile(REPOSITORY_CONFIG);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as CloudRepositoryConfig : {};
}
const describe = (error: unknown) => error instanceof CloudApiError || error instanceof Error ? error.message : String(error);
