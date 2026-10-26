import { createHash } from "node:crypto";
import { canonicalJson, isRecord, type RecordValue } from "./canonical-json";

export interface SubscriptionV2 extends RecordValue {
  id: string;
  vendor: string;
  /** Historical hint for display only. Never resolves ownership. */
  account?: string;
  account_key?: string;
  label?: string;
  note?: string;
  status?: "active" | "paused" | "cancelled" | "unknown";
}

export interface SourceV2 {
  vendor: string;
  machine?: string;
  login?: string;
  home: string;
  source_home?: string;
}

export interface AccountsV2 extends RecordValue {
  version: 2;
  subscriptions: SubscriptionV2[];
  sources: SourceV2[];
}

export interface AccountsConflict {
  code: "invalid" | "account-metadata" | "source-destination" | "archive-profiles";
  key: string;
  rows: number[];
  detail: string;
}

export interface AccountsPreparation {
  candidate: AccountsV2 | null;
  report: {
    status: "ready" | "conflicts" | "already-v2";
    original_sha256: string;
    original_bytes: number;
    legacy_rows: number;
    subscriptions: number;
    sources: number;
    removed_era_rows: number;
    removed_fields: Record<string, number>;
    conflicts: AccountsConflict[];
  };
}

const forbiddenSubscription = new Set(["machine", "login", "home", "source_home", "from", "until", "probe_subjects", "plan"]);
const forbiddenSource = new Set(["id", "account", "account_key", "from", "until", "probe_subjects", "plan", "note", "status"]);
const sourceFields = new Set(["vendor", "machine", "login", "home", "source_home"]);
const legacySourceFields = new Set(["machine", "login", "home", "source_home"]);
const legacyEraFields = new Set(["from", "until", "probe_subjects", "plan"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const provider = (value: string): string => {
  const name = value.trim().toLowerCase();
  return name === "anthropic" ? "claude" : name;
};
const pathKey = (value: string): string => value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const sourceName = (row: SourceV2): string => `${provider(row.vendor)}|${pathKey(row.home)}`;
const physicalName = (row: SourceV2): string | null => row.source_home
  ? `${provider(row.vendor)}|${(row.machine ?? "").trim().toLowerCase()}|${pathKey(row.source_home)}` : null;
const fail = (message: string): never => { throw new Error(`accounts v2: ${message}`); };

/** Strict current contract. Unknown descriptive fields on subscriptions and the root survive. */
export function parseAccountsV2(value: unknown): AccountsV2 {
  if (!isRecord(value)) throw new Error('accounts v2: expected an object with "version": 2');
  if (value.version !== 2) fail('expected an object with "version": 2');
  if ("source_mapping" in value) fail("source_mapping is obsolete");
  if (!Array.isArray(value.subscriptions) || !Array.isArray(value.sources)) throw new Error("accounts v2: subscriptions and sources must be arrays");
  const accounts = new Set<string>();
  const archive = new Map<string, string>();
  const physical = new Map<string, string>();
  const subscriptions: SubscriptionV2[] = [];
  for (const [index, entry] of value.subscriptions.entries()) {
    if (!isRecord(entry) || !text(entry.id) || !text(entry.vendor)) fail(`subscriptions[${index}] needs id and vendor`);
    for (const field of forbiddenSubscription) if (field in entry) fail(`subscriptions[${index}].${field} is obsolete`);
    for (const field of ["account", "account_key", "label", "note"])
      if (entry[field] !== undefined && typeof entry[field] !== "string") fail(`subscriptions[${index}].${field} must be text`);
    if (entry.status !== undefined && !["active", "paused", "cancelled", "unknown"].includes(String(entry.status)))
      fail(`subscriptions[${index}].status is invalid`);
    const key = `${provider(entry.vendor)}|${entry.id.trim().toLowerCase()}`;
    if (accounts.has(key)) fail(`duplicate subscription ${key}`);
    accounts.add(key);
    subscriptions.push(entry as SubscriptionV2);
  }
  const sources: SourceV2[] = [];
  for (const [index, entry] of value.sources.entries()) {
    if (!isRecord(entry) || !text(entry.vendor) || !text(entry.home)) fail(`sources[${index}] needs vendor and home`);
    for (const field of Object.keys(entry)) if (!sourceFields.has(field) || forbiddenSource.has(field)) fail(`sources[${index}].${field} is not a physical source field`);
    for (const field of ["machine", "login", "source_home"])
      if (entry[field] !== undefined && !text(entry[field])) fail(`sources[${index}].${field} must be nonempty text`);
    if (entry.source_home && !entry.machine) fail(`sources[${index}] needs machine for source_home`);
    const source = entry as unknown as SourceV2;
    const a = sourceName(source), p = physicalName(source);
    if (archive.has(a)) fail(`duplicate archive source ${a}`);
    if (p && physical.has(p)) fail(`local profile ${p} has multiple archive destinations`);
    archive.set(a, p ?? "");
    if (p) physical.set(p, a);
    sources.push(source);
  }
  return value as AccountsV2;
}

/** Pure preparation: old account eras are discarded as authority, never imported into periods. */
export function prepareAccountsV2(original: Uint8Array | string): AccountsPreparation {
  const bytes = typeof original === "string" ? Buffer.from(original) : Buffer.from(original);
  const sha = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { return failure(`invalid JSON: ${String(error)}`, sha, bytes.length); }
  if (!isRecord(value)) return failure("root must be an object", sha, bytes.length);
  if (value.version === 2) {
    try {
      const candidate = parseAccountsV2(value);
      return { candidate, report: { status: "already-v2", original_sha256: sha, original_bytes: bytes.length,
        legacy_rows: 0, subscriptions: candidate.subscriptions.length, sources: candidate.sources.length,
        removed_era_rows: 0, removed_fields: {}, conflicts: [] } };
    } catch (error) { return failure(String(error), sha, bytes.length); }
  }
  if (value.version !== undefined || "sources" in value || "source_mapping" in value || !Array.isArray(value.subscriptions))
    return failure("expected legacy subscriptions without version, sources or source_mapping", sha, bytes.length);
  const legacy = value.subscriptions;
  const conflicts: AccountsConflict[] = [];
  const subscriptions = new Map<string, { row: SubscriptionV2; index: number }>();
  const sources = new Map<string, { row: SourceV2; index: number }>();
  const physical = new Map<string, { archive: string; index: number }>();
  let eraRows = 0;
  const removedFields: Record<string, number> = {};
  for (const [index, raw] of legacy.entries()) {
    if (!isRecord(raw) || !text(raw.id) || (raw.vendor !== undefined && !text(raw.vendor))) {
      conflicts.push({ code: "invalid", key: `subscriptions[${index}]`, rows: [index], detail: "id and vendor must be nonempty text" });
      continue;
    }
    const vendor = provider(raw.vendor === undefined ? "codex" : raw.vendor as string);
    const id = raw.id.trim(), accountKey = `${vendor}|${id.toLowerCase()}`;
    const description: RecordValue = { ...raw, id, vendor };
    for (const field of legacySourceFields) delete description[field];
    for (const field of legacyEraFields) {
      if (field in description) removedFields[field] = (removedFields[field] ?? 0) + 1;
      delete description[field];
    }
    if (Object.keys(raw).some(field => legacyEraFields.has(field))) eraRows++;
    const prior = subscriptions.get(accountKey);
    if (prior) {
      for (const field of new Set([...Object.keys(prior.row), ...Object.keys(description)])) {
        if (field === "id" || !(field in description)) continue;
        if (!(field in prior.row)) { prior.row[field] = description[field]; continue; }
        if (canonicalJson(prior.row[field]) !== canonicalJson(description[field]))
          conflicts.push({ code: "account-metadata", key: `${accountKey}.${field}`, rows: [prior.index, index], detail: "different descriptions for one account" });
      }
    } else subscriptions.set(accountKey, { row: description as SubscriptionV2, index });
    if (raw.home === undefined || raw.home === null || raw.home === "") {
      if (raw.source_home !== undefined && raw.source_home !== null) conflicts.push({ code: "invalid", key: `subscriptions[${index}].source_home`, rows: [index], detail: "local profile has no archive home" });
      continue;
    }
    if (!text(raw.home) || (raw.machine !== undefined && !text(raw.machine)) ||
      (raw.login !== undefined && !text(raw.login)) || (raw.source_home !== undefined && raw.source_home !== null && !text(raw.source_home))) {
      conflicts.push({ code: "invalid", key: `subscriptions[${index}]`, rows: [index], detail: "invalid physical source field" });
      continue;
    }
    const source: SourceV2 = { vendor, ...(raw.machine ? { machine: raw.machine as string } : {}),
      ...(raw.login ? { login: raw.login as string } : {}), home: raw.home,
      ...(raw.source_home ? { source_home: raw.source_home as string } : {}) };
    if (source.source_home && !source.machine) {
      conflicts.push({ code: "invalid", key: `subscriptions[${index}].machine`, rows: [index], detail: "local source needs machine" });
      continue;
    }
    const archiveKey = sourceName(source), physicalKey = physicalName(source);
    if (physicalKey) {
      const mapped = physical.get(physicalKey);
      if (mapped && mapped.archive !== archiveKey)
        conflicts.push({ code: "source-destination", key: physicalKey, rows: [mapped.index, index], detail: "local profile names different archive destinations" });
      else physical.set(physicalKey, { archive: archiveKey, index });
    }
    const archived = sources.get(archiveKey);
    if (archived) {
      const same = (field: keyof SourceV2) => {
        if (source[field] === undefined) return true;
        if (archived.row[field] === undefined) { archived.row[field] = source[field]; return true; }
        return field === "home" || field === "source_home"
          ? pathKey(archived.row[field]!) === pathKey(source[field]!)
          : archived.row[field]!.trim().toLowerCase() === source[field]!.trim().toLowerCase();
      };
      if (!["vendor", "machine", "login", "home", "source_home"].every(field => same(field as keyof SourceV2)))
        conflicts.push({ code: "archive-profiles", key: archiveKey, rows: [archived.index, index], detail: "archive folder names different physical profiles" });
      continue;
    }
    sources.set(archiveKey, { row: source, index });
  }
  const report = { status: conflicts.length ? "conflicts" as const : "ready" as const, original_sha256: sha,
    original_bytes: bytes.length, legacy_rows: legacy.length, subscriptions: subscriptions.size,
    sources: sources.size, removed_era_rows: eraRows, removed_fields: removedFields, conflicts };
  if (conflicts.length) return { candidate: null, report };
  const candidate = { ...value, version: 2 as const, subscriptions: [...subscriptions.values()].map(x => x.row),
    sources: [...sources.values()].map(x => x.row) };
  try { parseAccountsV2(candidate); }
  catch (error) { return { candidate: null, report: { ...report, status: "conflicts", conflicts: [{ code: "invalid", key: "candidate", rows: [], detail: String(error) }] } }; }
  return { candidate, report };
}

function failure(detail: string, sha: string, length: number): AccountsPreparation {
  return { candidate: null, report: { status: "conflicts", original_sha256: sha, original_bytes: length,
    legacy_rows: 0, subscriptions: 0, sources: 0, removed_era_rows: 0,
    removed_fields: {},
    conflicts: [{ code: "invalid", key: "document", rows: [], detail }] } };
}
