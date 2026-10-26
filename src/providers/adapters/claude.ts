import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database } from "bun:sqlite";
import { normalizeProbeError, persistProbeWindows, probeTarget, runProbeCycle as runCoreProbeCycle } from "../core/probe";
import { ProviderProbeError, type ProbeCycleOptions, type ProbeFetch, type ProbeHttpResponse, type ProviderProbeAdapter, type WindowReading } from "../types";
import { ProbeAccountIndexUnavailable, readPreparedProbeAccountRows, type ProbeAccountReadings } from "../../server/current/probe-account-reader";
import type { ClaudeAccountMeter, ClaudeAccountMeters } from "../../shared/claude-code-capacity";
import { claudeLoginMissing, codedProbeError } from "../../shared/probe-error";
import { claudeTokenDue, refreshableProfileHome, refreshClaudeCredentials, type ClaudeRefreshFailure } from "./claude-token-refresh";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8_000;
export interface ClaudeCredentials {
  token: string;
  expires_at: number | null;
  subscription_type: string | null;
}
export function claudeCredentialsPath(home?: string): string {
  return path.join(home || path.join(os.homedir(), ".claude"), ".credentials.json");
}
export function readClaudeCredentials(home?: string): { creds: ClaudeCredentials | null; error: string | null } {
  const file = claudeCredentialsPath(home);
  if (!fs.existsSync(file)) return { creds: null, error: claudeLoginMissing(file) };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return { creds: null, error: "poświadczenia nieczytelne" };
  }
  const oauth = (raw.claudeAiOauth ?? raw.oauth ?? raw) as Record<string, unknown>;
  const token = (oauth.accessToken ?? oauth.access_token) as string | undefined;
  // The CLI blanks both tokens when its refresh token is refused; signing in again is the only remedy.
  if (!token) return { creds: null, error: loginExpiredMessage("the profile holds no access token (signed out)") };
  const rawExpiration = (oauth.expiresAt ?? oauth.expires_at) as number | undefined;
  const expiresAt = typeof rawExpiration === "number"
    ? rawExpiration > 1e12 ? rawExpiration : rawExpiration * 1000
    : null;
  return {
    creds: {
      token,
      expires_at: expiresAt,
      subscription_type: (oauth.subscriptionType as string) ?? null,
    },
    error: null,
  };
}
/** The CLI's trusted-device token, which session history routes require; null until the device is enrolled. */
export function readClaudeTrustedDevice(home?: string): string | null {
  try {
    const value = (JSON.parse(fs.readFileSync(claudeCredentialsPath(home), "utf-8")) as { trustedDeviceToken?: unknown }).trustedDeviceToken;
    return typeof value === "string" && value ? value : null;
  } catch { return null; }
}
export interface ClaudeProbeLimit {
  kind: string;
  group: string | null;
  scope_label: string | null;
  percent: number;
  severity: string | null;
  resets_at: string | null;
  is_active: boolean;
}
export interface ClaudeProbeResult {
  subscription: string;
  ts: string;
  plan: string | null;
  limits: ClaudeProbeLimit[];
  product_share?: ClaudeCodeProductShare | null;
  product_breakdown?: ClaudeProductBreakdown | null;
  error: string | null;
}
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  is_active?: boolean;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: unknown } | null;
}
interface RawBar {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawBreakdownRow {
  key?: unknown;
  display_name?: unknown;
  percent?: unknown;
}
interface RawUsage {
  limits?: RawLimit[];
  five_hour?: RawBar | null;
  seven_day?: RawBar | null;
  seven_day_breakdown?: unknown;
  [key: string]: unknown;
}
/** Scalar extra keys for the Claude Code product share. Extra cannot store nested JSON. */
export const CLAUDE_CODE_SHARE_EXTRA = {
  schema: "claude.share.schema",
  key: "claude.share.key",
  percent: "claude.share.percent",
  asOf: "claude.share.as_of",
  windowStartedAt: "claude.share.window_started_at",
  displayName: "claude.share.display_name",
} as const;
export const CLAUDE_CODE_SHARE_SCHEMA = 1;
export const CLAUDE_CODE_SHARE_KEY = "claude_code";
export interface ClaudeCodeProductShare {
  schema: typeof CLAUDE_CODE_SHARE_SCHEMA;
  key: typeof CLAUDE_CODE_SHARE_KEY;
  percent: number;
  as_of: string;
  window_started_at: string;
  display_name: string | null;
}
export function parseUsagePayload(data: RawUsage): ClaudeProbeLimit[] {
  const limits: ClaudeProbeLimit[] = [];
  if (Array.isArray(data.limits) && data.limits.length > 0) {
    for (const limit of data.limits) {
      if (typeof limit?.percent !== "number") continue;
      limits.push({
        kind: limit.kind || "unknown",
        group: limit.group ?? null,
        scope_label: limit.scope?.model?.display_name ?? null,
        percent: limit.percent,
        severity: limit.severity ?? null,
        resets_at: limit.resets_at ?? null,
        is_active: limit.is_active === true,
      });
    }
    if (limits.length > 0) return limits;
  }
  for (const [key, kind] of [["five_hour", "session"], ["seven_day", "weekly_all"]] as const) {
    const bar = data[key];
    if (bar && typeof bar.utilization === "number") {
      limits.push({
        kind,
        group: kind === "session" ? "session" : "weekly",
        scope_label: null,
        percent: bar.utilization,
        severity: null,
        resets_at: bar.resets_at ?? null,
        is_active: false,
      });
    }
  }
  return limits;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteInstant(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
function accountWeeklyAll(limit: ClaudeProbeLimit): boolean {
  return limit.kind === "weekly_all" && (limit.scope_label == null || limit.scope_label === "");
}
function coherentShareWindow(share: { as_of: string; window_started_at: string }, resetsAt: string | null): boolean {
  const reset = finiteInstant(resetsAt);
  if (!reset) return false;
  const start = Date.parse(share.window_started_at);
  const asOf = Date.parse(share.as_of);
  const end = Date.parse(reset);
  return start <= asOf && asOf <= end && end - start === 7 * 24 * 60 * 60_000;
}
function matchingAccountWeeklyLimit(data: RawUsage, limits: ClaudeProbeLimit[]): ClaudeProbeLimit | null {
  const weekly = limits.filter(accountWeeklyAll);
  if (weekly.length !== 1) return null;
  const selected = weekly[0]!;
  if (!Number.isFinite(selected.percent) || selected.percent < 0 || selected.percent > 100) return null;
  // A missing display label does not turn a model/product-scoped limit into an account meter.
  if (Array.isArray(data.limits) && data.limits.some(limit => limit?.kind === "weekly_all"
    && (limit.scope?.model != null || limit.scope?.surface != null))) return null;
  const legacy = data.seven_day;
  if (legacy && (legacy.utilization !== selected.percent || !legacy.resets_at || !selected.resets_at
    || Date.parse(legacy.resets_at) !== Date.parse(selected.resets_at))) return null;
  return selected;
}
/** Observed Code share from `seven_day_breakdown`. Invalid/ambiguous payloads stay absent. */
export function parseClaudeCodeProductShare(data: RawUsage): ClaudeCodeProductShare | null {
  const breakdown = data.seven_day_breakdown;
  if (!isRecord(breakdown)) return null;
  const as_of = finiteInstant(breakdown.as_of);
  const window_started_at = finiteInstant(breakdown.window_started_at);
  if (!as_of || !window_started_at) return null;
  if (Date.parse(as_of) < Date.parse(window_started_at)) return null;
  if (!Array.isArray(breakdown.rows)) return null;
  const codeRows = breakdown.rows.filter((row): row is RawBreakdownRow => isRecord(row) && row.key === CLAUDE_CODE_SHARE_KEY);
  if (codeRows.length !== 1) return null;
  const percent = codeRows[0]!.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const display = codeRows[0]!.display_name;
  return {
    schema: CLAUDE_CODE_SHARE_SCHEMA,
    key: CLAUDE_CODE_SHARE_KEY,
    percent,
    as_of,
    window_started_at,
    display_name: typeof display === "string" ? display : null,
  };
}
/** Vendor keys are used as `extra` field names, so only a plain slug is accepted. */
const BREAKDOWN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const CLAUDE_BREAKDOWN_EXTRA = {
  schema: "claude.breakdown.schema",
  asOf: "claude.breakdown.as_of",
  windowStartedAt: "claude.breakdown.window_started_at",
  percentPrefix: "claude.breakdown.percent.",
  labelPrefix: "claude.breakdown.label.",
} as const;
export const CLAUDE_BREAKDOWN_SCHEMA = 1;
export interface ClaudeProductBreakdownRow {
  key: string;
  percent: number;
  display_name: string | null;
}
/**
 * Every surface row of `seven_day_breakdown`, not only Claude Code: the rows say how the
 * week's USED bar splits across Claude Code, chat, Cowork and the rest, which is the only
 * account-side evidence of spend the local index cannot see.
 */
export interface ClaudeProductBreakdown {
  schema: typeof CLAUDE_BREAKDOWN_SCHEMA;
  as_of: string;
  window_started_at: string;
  rows: ClaudeProductBreakdownRow[];
}
function breakdownPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
export function parseClaudeProductBreakdown(data: RawUsage): ClaudeProductBreakdown | null {
  const breakdown = data.seven_day_breakdown;
  if (!isRecord(breakdown)) return null;
  const as_of = finiteInstant(breakdown.as_of);
  const window_started_at = finiteInstant(breakdown.window_started_at);
  if (!as_of || !window_started_at) return null;
  if (Date.parse(as_of) < Date.parse(window_started_at)) return null;
  if (!Array.isArray(breakdown.rows) || breakdown.rows.length === 0) return null;
  const rows: ClaudeProductBreakdownRow[] = [];
  const seen = new Set<string>();
  for (const row of breakdown.rows) {
    if (!isRecord(row)) return null;
    const key = row.key;
    if (typeof key !== "string" || !BREAKDOWN_KEY_PATTERN.test(key)) return null;
    // A repeated surface would make its share ambiguous; the whole breakdown is dropped.
    if (seen.has(key)) return null;
    seen.add(key);
    const percent = breakdownPercent(row.percent);
    if (percent == null) return null;
    const display = (row as RawBreakdownRow).display_name;
    rows.push({ key, percent, display_name: typeof display === "string" ? display : null });
  }
  return { schema: CLAUDE_BREAKDOWN_SCHEMA, as_of, window_started_at, rows };
}
export function encodeClaudeProductBreakdown(
  breakdown: ClaudeProductBreakdown
): Record<string, string | number | boolean | null> {
  const extra: Record<string, string | number | boolean | null> = {
    [CLAUDE_BREAKDOWN_EXTRA.schema]: breakdown.schema,
    [CLAUDE_BREAKDOWN_EXTRA.asOf]: breakdown.as_of,
    [CLAUDE_BREAKDOWN_EXTRA.windowStartedAt]: breakdown.window_started_at,
  };
  for (const row of breakdown.rows) {
    extra[`${CLAUDE_BREAKDOWN_EXTRA.percentPrefix}${row.key}`] = row.percent;
    extra[`${CLAUDE_BREAKDOWN_EXTRA.labelPrefix}${row.key}`] = row.display_name;
  }
  return extra;
}
export function claudeProductBreakdownFromExtra(
  extra: Record<string, string | number | boolean | null> | string | null | undefined
): ClaudeProductBreakdown | null {
  const fields = extraFields(extra);
  if (!fields) return null;
  if (fields[CLAUDE_BREAKDOWN_EXTRA.schema] !== CLAUDE_BREAKDOWN_SCHEMA) return null;
  const as_of = finiteInstant(fields[CLAUDE_BREAKDOWN_EXTRA.asOf]);
  const window_started_at = finiteInstant(fields[CLAUDE_BREAKDOWN_EXTRA.windowStartedAt]);
  if (!as_of || !window_started_at) return null;
  if (Date.parse(as_of) < Date.parse(window_started_at)) return null;
  const rows: ClaudeProductBreakdownRow[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith(CLAUDE_BREAKDOWN_EXTRA.percentPrefix)) continue;
    const key = field.slice(CLAUDE_BREAKDOWN_EXTRA.percentPrefix.length);
    if (!BREAKDOWN_KEY_PATTERN.test(key)) return null;
    const percent = breakdownPercent(value);
    if (percent == null) return null;
    const display = fields[`${CLAUDE_BREAKDOWN_EXTRA.labelPrefix}${key}`];
    rows.push({ key, percent, display_name: typeof display === "string" ? display : null });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.percent - a.percent || a.key.localeCompare(b.key));
  return { schema: CLAUDE_BREAKDOWN_SCHEMA, as_of, window_started_at, rows };
}
export function encodeClaudeCodeProductShare(share: ClaudeCodeProductShare): Record<string, string | number | boolean | null> {
  return {
    [CLAUDE_CODE_SHARE_EXTRA.schema]: share.schema,
    [CLAUDE_CODE_SHARE_EXTRA.key]: share.key,
    [CLAUDE_CODE_SHARE_EXTRA.percent]: share.percent,
    [CLAUDE_CODE_SHARE_EXTRA.asOf]: share.as_of,
    [CLAUDE_CODE_SHARE_EXTRA.windowStartedAt]: share.window_started_at,
    [CLAUDE_CODE_SHARE_EXTRA.displayName]: share.display_name,
  };
}
function extraFields(
  extra: Record<string, string | number | boolean | null> | string | null | undefined
): Record<string, unknown> | null {
  if (typeof extra === "string") {
    try {
      const parsed: unknown = JSON.parse(extra);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(extra) ? extra : null;
}
export function claudeCodeProductShareFromExtra(
  extra: Record<string, string | number | boolean | null> | string | null | undefined
): ClaudeCodeProductShare | null {
  const fields = extraFields(extra);
  if (!fields) return null;
  const schema = fields[CLAUDE_CODE_SHARE_EXTRA.schema];
  const key = fields[CLAUDE_CODE_SHARE_EXTRA.key];
  const percent = fields[CLAUDE_CODE_SHARE_EXTRA.percent];
  const as_of = finiteInstant(fields[CLAUDE_CODE_SHARE_EXTRA.asOf]);
  const window_started_at = finiteInstant(fields[CLAUDE_CODE_SHARE_EXTRA.windowStartedAt]);
  if (schema !== CLAUDE_CODE_SHARE_SCHEMA || key !== CLAUDE_CODE_SHARE_KEY || !as_of || !window_started_at) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (Date.parse(as_of) < Date.parse(window_started_at)) return null;
  const display = fields[CLAUDE_CODE_SHARE_EXTRA.displayName];
  return {
    schema: CLAUDE_CODE_SHARE_SCHEMA,
    key: CLAUDE_CODE_SHARE_KEY,
    percent,
    as_of,
    window_started_at,
    display_name: typeof display === "string" ? display : null,
  };
}
export const CLAUDE_RAW_USAGE_PREFIX = "claude.raw.";
const RAW_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const RAW_MAX_DEPTH = 4;
/** Longer strings are vendor prose (disclaimers), not measurements. */
const RAW_MAX_STRING = 64;
/**
 * Every non-null scalar of the usage payload outside the parts already decoded
 * (`limits[]`, `seven_day_breakdown`), flattened as `claude.raw.<path>`. The endpoint carries
 * many dormant meters (`seven_day_opus`, codenamed slots, `extra_usage`, `spend`, dollar
 * fields); keeping whatever is live preserves a newly enabled meter from its first reading,
 * before any parser knows its meaning. Nulls are the vendor's "not active" and stay absent.
 */
export function encodeClaudeRawUsage(data: RawUsage): Record<string, string | number | boolean> {
  const extra: Record<string, string | number | boolean> = {};
  const visit = (value: unknown, path: string, depth: number) => {
    if (value == null) return;
    if (typeof value === "number") { if (Number.isFinite(value)) extra[path] = value; return; }
    if (typeof value === "boolean") { extra[path] = value; return; }
    if (typeof value === "string") { if (value.length <= RAW_MAX_STRING) extra[path] = value; return; }
    if (depth >= RAW_MAX_DEPTH || typeof value !== "object") return;
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
    for (const [key, item] of entries) if (RAW_SEGMENT.test(key)) visit(item, `${path}.${key}`, depth + 1);
  };
  for (const [key, value] of Object.entries(data)) {
    if (key === "limits" || key === "seven_day_breakdown" || !RAW_SEGMENT.test(key)) continue;
    visit(value, `${CLAUDE_RAW_USAGE_PREFIX}${key}`, 0);
  }
  return extra;
}
/** Meters that already have limit windows (`limits[]`), and payload fields that are not meters. */
const WINDOWED_RAW_METERS = new Set(["five_hour", "seven_day"]);
/**
 * The account meters of one stored reading, decoded from its `claude.raw.*` fields. A meter is a
 * field with a `utilization`; dormant meters were never stored (nulls stay absent), so what is
 * listed is what the vendor reported as live.
 */
export function decodeClaudeAccountMeters(extra: Record<string, unknown>, readAt: string): ClaudeAccountMeters {
  const fields = new Map<string, Map<string, unknown>>();
  for (const [path, value] of Object.entries(extra)) {
    if (!path.startsWith(CLAUDE_RAW_USAGE_PREFIX)) continue;
    const [meter, ...rest] = path.slice(CLAUDE_RAW_USAGE_PREFIX.length).split(".");
    if (!meter || rest.length === 0) continue;
    const known = fields.get(meter) ?? new Map<string, unknown>();
    known.set(rest.join("."), value);
    fields.set(meter, known);
  }
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const text = (value: unknown) => typeof value === "string" ? value : null;
  const meters: ClaudeAccountMeter[] = [...fields]
    .filter(([key, values]) => !WINDOWED_RAW_METERS.has(key) && values.has("utilization"))
    .map(([key, values]) => ({
      key,
      utilization_percent: number(values.get("utilization")),
      resets_at: text(values.get("resets_at")),
      limit_dollars: number(values.get("limit_dollars")),
      used_dollars: number(values.get("used_dollars")),
      remaining_dollars: number(values.get("remaining_dollars")),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const extraUsage = fields.get("extra_usage"), spend = fields.get("spend");
  return {
    read_at: readAt,
    meters,
    extra_usage: extraUsage?.has("is_enabled") ? {
      enabled: extraUsage.get("is_enabled") === true,
      user_disabled: typeof extraUsage.get("user_disabled") === "boolean" ? extraUsage.get("user_disabled") as boolean : null,
      spent_minor: number(spend?.get("used.amount_minor")),
      currency: text(spend?.get("used.currency")),
      exponent: number(spend?.get("used.exponent")),
    } : null,
  };
}
function extraForLimit(limit: ClaudeProbeLimit, share: ClaudeCodeProductShare | null,
  breakdown: ClaudeProductBreakdown | null, raw: Record<string, string | number | boolean> | null,
  attach: boolean): WindowReading["extra"] {
  const extra: Record<string, string | number | boolean | null> = {
    severity: limit.severity,
    is_active: limit.is_active,
  };
  if (attach && share) Object.assign(extra, encodeClaudeCodeProductShare(share));
  if (attach && breakdown) Object.assign(extra, encodeClaudeProductBreakdown(breakdown));
  if (attach && raw) Object.assign(extra, raw);
  return extra;
}
interface ClaudeTarget {
  expectedIdentity?: {accountId: string | null; organizationId: string | null; email: string | null};
  subscription: string;
  home?: string;
  /**
   * Whether the probe may refresh an expired token in this profile: only for a profile of the machine it runs
   * on, and only when the caller says so. A remote machine's profile is never written.
   */
  refreshable?: boolean;
  /** Told when the probe replaced the profile's `.credentials.json` (a refresh), so a revision check expects it. */
  onCredentialsRewritten?: () => void;
}
type ClaudeIdentity = NonNullable<ClaudeTarget["expectedIdentity"]>;
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// An access token is issued to one account and organization for its whole life, so the owner the
// profile endpoint confirmed can be reused for that token; a refreshed token is a new key.
const IDENTITY_CACHE_MS = 60 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 6 * 60 * 60_000;
// Keyed by a SHA-256 of the token; the token itself is never kept.
const tokenOwners = new Map<string, { identity: ClaudeIdentity; until: number }>();
const profileRetryAt = new Map<string, number>();
/** Forgets confirmed token owners and rate-limit back-offs (tests). */
export function resetClaudeIdentityCache(): void {
  tokenOwners.clear();
  profileRetryAt.clear();
}
const tokenKey = (token: string) => createHash("sha256").update(token).digest("hex");
const idText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
/** Enough of an identifier to tell two apart in a message, never the whole of it. */
const tail = (value: string) => `…${value.slice(-4)}`;
const maskEmail = (value: string) => { const at = value.indexOf("@"); return at > 0 ? `${value[0]}…${value.slice(at)}` : tail(value); };
const SIGN_IN = "run `claude` and sign in (/login)";
function loginExpiredMessage(detail: string): string {
  return codedProbeError("login-expired", `Claude sign-in expired: ${detail}; ${SIGN_IN}.`);
}
const loginExpired = (detail: string) => new ProviderProbeError(loginExpiredMessage(detail));
const tokenStale = (credentials: ClaudeCredentials) => credentials.expires_at != null && credentials.expires_at < Date.now();
/** A 401 from the profile or usage endpoint: the token is expired or revoked; one refresh may cure it. */
class ClaudeTokenRejected extends ProviderProbeError {
  constructor(readonly endpoint: "profile" | "usage", credentials: ClaudeCredentials) {
    super(loginExpiredMessage(tokenStale(credentials) ? `the access token expired (HTTP 401 from the ${endpoint} endpoint)`
      : `the access token was rejected, revoked or replaced (HTTP 401 from the ${endpoint} endpoint)`));
  }
}
const SAVE_REASONS = {
  "explicit-acl": "the credentials file has its own Windows permissions, which a replacement would not keep; it was not refreshed",
  "acl-unknown": "the credentials file's Windows permissions could not be read; it was not refreshed",
  "not-writable": "the profile directory does not accept a new file; it was not refreshed",
  "replace-failed": "the refreshed sign-in could not be written to the credentials file (the file was left as it was)",
} as const;
/** Status codes and OAuth error names only: a refresh failure never carries a token or vendor prose. */
/** The probe's explanation of a failed token refresh (also reported by the cloud session sync). */
export function refreshFailure(failure: ClaudeRefreshFailure): ProviderProbeError {
  if (failure !== "no-refresh-token" && "save" in failure) return new ProviderProbeError(codedProbeError("login-save-failed",
    `Claude sign-in could not be saved: ${SAVE_REASONS[failure.save]}; run \`claude\` (it signs in again if needed, /login).`));
  if (failure === "no-refresh-token") return loginExpired("the profile holds no refresh token");
  if ("oauthError" in failure) return loginExpired(`the token refresh was refused (${failure.oauthError}, HTTP ${failure.status})`);
  return loginExpired(failure.status == null ? "the token endpoint could not be reached" : `the token endpoint failed (HTTP ${failure.status})`);
}
function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
const unverified = (detail: string) => new ProviderProbeError(`Claude identity check failed: ${detail}; usage was not attributed.`);
function profileRefusal(status: number, retryAfter: string | null | undefined, credentials: ClaudeCredentials, key: string): ProviderProbeError {
  if (status === 401) return new ClaudeTokenRejected("profile", credentials);
  if (status === 403) return tokenStale(credentials) ? loginExpired("the access token expired (HTTP 403 from the profile endpoint)")
    : unverified("HTTP 403, the token lacks the user:profile scope, so its account cannot be verified (a `claude setup-token` token "
      + "carries inference only); sign in with `claude` /login");
  if (status === 429) {
    const now = Date.now();
    profileRetryAt.set(key, now + Math.min(retryAfterMs(retryAfter, now) ?? RATE_LIMIT_BACKOFF_MS, MAX_RATE_LIMIT_BACKOFF_MS));
    return unverified(`HTTP 429, the profile endpoint is rate limiting this token (${retryAfter ? `Retry-After ${retryAfter}` : "no Retry-After"})`);
  }
  if (status >= 500) return unverified(`HTTP ${status}, the profile endpoint failed at Anthropic`);
  return unverified(`HTTP ${status} from the profile endpoint`);
}
/** Names the first field where the token's owner differs from the profile's, or null when they agree. */
function identityMismatch(expected: ClaudeIdentity, actual: ClaudeIdentity): string | null {
  if (expected.accountId) {
    if (actual.accountId !== expected.accountId) return actual.accountId
      ? `account ${tail(actual.accountId)}, expected ${tail(expected.accountId)}`
      : `the profile answer has no account uuid, expected ${tail(expected.accountId)}`;
  } else if (!expected.email) {
    return "this profile names neither an account uuid nor an email";
  } else if (actual.email?.toLowerCase() !== expected.email.toLowerCase()) {
    return actual.email ? `email ${maskEmail(actual.email)}, expected ${maskEmail(expected.email)}`
      : `the profile answer has no email, expected ${maskEmail(expected.email)}`;
  }
  if (expected.organizationId && actual.organizationId !== expected.organizationId) return actual.organizationId
    ? `organization ${tail(actual.organizationId)}, expected ${tail(expected.organizationId)}`
    : `the profile answer has no organization uuid, expected ${tail(expected.organizationId)}`;
  return null;
}
/**
 * Usage carries no account identity, so the token's owner is confirmed through the profile endpoint
 * before a reading is attributed. Every failure withholds the reading and says why.
 */
async function verifyClaudeIdentity(expected: ClaudeIdentity, credentials: ClaudeCredentials, fetchJson: ProbeFetch): Promise<void> {
  const key = tokenKey(credentials.token);
  const now = Date.now();
  let owner = tokenOwners.get(key);
  if (owner && owner.until <= now) { tokenOwners.delete(key); owner = undefined; }
  if (!owner) {
    const retryAt = profileRetryAt.get(key);
    if (retryAt != null && retryAt > now) {
      throw unverified(`the profile endpoint is rate limiting this token (HTTP 429), next check after ${new Date(retryAt).toISOString()}`);
    }
    profileRetryAt.delete(key);
    let profile: ProbeHttpResponse<{ account?: { uuid?: unknown; email?: unknown }; organization?: { uuid?: unknown } }>;
    try {
      profile = await fetchJson(PROFILE_URL,
        { method: "GET", headers: { Authorization: `Bearer ${credentials.token}`, "anthropic-beta": "oauth-2025-04-20" } },
        TIMEOUT_MS, `Claude identity check failed: no answer from the profile endpoint in ${TIMEOUT_MS} ms; usage was not attributed.`);
    } catch (error) {
      if (error instanceof ProviderProbeError) throw error;
      throw unverified(`the profile endpoint could not be reached (${normalizeProbeError(error)})`);
    }
    if (!profile.ok) throw profileRefusal(profile.status, profile.retryAfter, credentials, key);
    const identity: ClaudeIdentity = {
      accountId: idText(profile.body?.account?.uuid),
      email: idText(profile.body?.account?.email),
      organizationId: idText(profile.body?.organization?.uuid),
    };
    owner = { identity, until: Math.min(now + IDENTITY_CACHE_MS, credentials.expires_at ?? Infinity) };
    if ((identity.accountId || identity.email) && owner.until > now) {
      for (const [stored, entry] of tokenOwners) if (entry.until <= now) tokenOwners.delete(stored);
      tokenOwners.set(key, owner);
    }
  }
  const mismatch = identityMismatch(expected, owner.identity);
  if (mismatch) throw new ProviderProbeError(codedProbeError("login-mismatch",
    `Claude OAuth identity does not match this profile (${mismatch}); usage was not attributed.`));
}
interface ClaudeRaw {
  usage: RawUsage;
  plan: string | null;
}
async function readClaudeUsage(target: ClaudeTarget, credentials: ClaudeCredentials, fetchJson: ProbeFetch): Promise<ClaudeRaw> {
  if (target.expectedIdentity) await verifyClaudeIdentity(target.expectedIdentity, credentials, fetchJson);
  const response = await fetchJson<RawUsage>(
    USAGE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    TIMEOUT_MS,
    `brak odpowiedzi w ${TIMEOUT_MS} ms`
  );
  if (response.status === 401) throw new ClaudeTokenRejected("usage", credentials);
  if (response.status === 403) throw tokenStale(credentials) ? loginExpired("the access token expired (HTTP 403 from the usage endpoint)")
    : new ProviderProbeError(`konto odrzuciło odczyt (HTTP ${response.status})`);
  if (!response.ok || !response.body) throw new ProviderProbeError(`HTTP ${response.status}`);
  return { usage: response.body, plan: credentials.subscription_type };
}
type ClaudeReading = WindowReading;
interface ClaudeMeta {
  plan: string | null;
  limits: ClaudeProbeLimit[];
  product_share: ClaudeCodeProductShare | null;
  product_breakdown: ClaudeProductBreakdown | null;
}
export const claudeProbeAdapter: ProviderProbeAdapter<
  ClaudeTarget,
  ClaudeCredentials,
  ClaudeRaw,
  ClaudeReading,
  ClaudeMeta,
  ClaudeProbeSample
> = {
  id: "claude",
  capabilities: {
    reportsPercent: "used",
    reportsAllowance: false,
    unit: "percent",
    windows: "multiple",
    targetConcurrency: "parallel",
  },
  subject: (target) => target.subscription,
  credentials: (target) => readClaudeCredentials(target.home),
  async request(target, { credentials, fetchJson }) {
    const home = target.home ?? path.dirname(claudeCredentialsPath());
    // Only a profile on this machine's own disk, inside the user's home directory (see refreshableProfileHome).
    const refreshable = target.refreshable === true && refreshableProfileHome(home) !== null;
    let current = credentials;
    let refreshed = false;
    // One refresh per reading, under the CLI's lock; the token is then read back from the file.
    const renew = async (force: boolean) => {
      refreshed = true;
      const outcome = await refreshClaudeCredentials({ home, usedToken: current.token, force, onRewritten: target.onCredentialsRewritten });
      if (outcome.status === "failed") throw refreshFailure(outcome.failure);
      if (outcome.status === "busy")
        throw new ProviderProbeError("Claude token refresh is held by another process (its lock is busy); this reading was skipped");
      const next = readClaudeCredentials(target.home);
      if (!next.creds) throw new ProviderProbeError(next.error ?? loginExpiredMessage("the profile holds no access token after the refresh"));
      current = next.creds;
    };
    if (refreshable && claudeTokenDue(current.expires_at)) {
      // A token due within minutes still reads; only an expired one makes a failed refresh final.
      try { await renew(false); } catch (error) { if (tokenStale(current)) throw error; }
    }
    try {
      return await readClaudeUsage(target, current, fetchJson);
    } catch (error) {
      if (!(error instanceof ClaudeTokenRejected) || !refreshable || refreshed) throw error;
      await renew(true);
      return await readClaudeUsage(target, current, fetchJson);
    }
  },
  parse(raw) {
    const limits = parseUsagePayload(raw.usage);
    const parsedShare = parseClaudeCodeProductShare(raw.usage);
    const parsedBreakdown = parseClaudeProductBreakdown(raw.usage);
    const weekly = matchingAccountWeeklyLimit(raw.usage, limits);
    const attached = parsedShare && weekly && coherentShareWindow(parsedShare, weekly.resets_at)
      ? parsedShare : null;
    const attachedBreakdown = parsedBreakdown && weekly && coherentShareWindow(parsedBreakdown, weekly.resets_at)
      ? parsedBreakdown : null;
    // Raw meters are account-level evidence, so they ride on the account weekly bar even
    // when the product share is rejected; they never touch the share contract.
    const rawUsage = encodeClaudeRawUsage(raw.usage);
    return {
      readings: limits.map((limit) => ({
        kind: limit.kind,
        group: limit.group,
        scope: limit.scope_label,
        plan: raw.plan,
        reportedPercentSide: "used" as const,
        usedPercent: limit.percent,
        remainingPercent: null,
        allowance: null,
        used: null,
        remaining: null,
        vendorPercent: limit.percent,
        windowMinutes: null,
        resetsAt: limit.resets_at,
        rateLimitReached: null,
        resetCredits: null,
        profile: null,
        ok: null,
        error: null,
        extra: extraForLimit(limit, attached, attachedBreakdown, rawUsage, accountWeeklyAll(limit)),
      })),
      meta: { plan: raw.plan, limits, product_share: attached, product_breakdown: attachedBreakdown },
    };
  },
  validate: ({ readings }) => readings.length === 0 ? "odpowiedź bez rozpoznanych słupków" : null,
  persist(sqlite, readings, context) {
    return persistProbeWindows(sqlite, "claude", context.target.subscription, context.ts, readings);
  },
  read: (sqlite, subscription) => readClaudeProbe(sqlite, subscription),
};
export async function probeClaudeUsage(subscription: string, home?: string): Promise<ClaudeProbeResult> {
  const outcome = await probeTarget(claudeProbeAdapter, { subscription, home, refreshable: true });
  return {
    subscription,
    ts: outcome.ts,
    plan: outcome.meta?.plan ?? outcome.credentials?.subscription_type ?? null,
    limits: outcome.meta?.limits ?? [],
    ...(outcome.meta?.product_share ? { product_share: outcome.meta.product_share } : {}),
    error: outcome.error,
  };
}
export interface ClaudeProbeCycleResult {
  ts: string;
  rows: number;
  error: string | null;
}
export async function runClaudeProbeCycle(
  sqlite: Database,
  subscription: string,
  home?: string,
  options?: ProbeCycleOptions
): Promise<ClaudeProbeCycleResult> {
  // This server's own profile (the default one unless `home` names another local directory).
  const cycle = await runCoreProbeCycle(sqlite, claudeProbeAdapter, [{ subscription, home, refreshable: true }], options);
  const outcome = cycle.outcomes[0]!;
  return { ts: outcome.ts, rows: outcome.rows, error: outcome.error };
}
export interface ClaudeProbeSample {
  ts: string;
  kind: string;
  scope_label: string | null;
  percent: number;
  resets_at: string | null;
  product_share?: ClaudeCodeProductShare;
  product_breakdown?: ClaudeProductBreakdown;
}
export const RESET_TOLERANCE_MS = 30 * 60_000;
export function sameResetWindow(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return a === b;
  return Math.abs(left - right) <= RESET_TOLERANCE_MS;
}
const MAX_PROBE_ROWS = 20_000;
/** The newest sample per counter and reset window; `readings` reuses the account's readings already read (newest first, as the index answers). */
export function readClaudeProbe(sqlite: Database, subscription: string, readings?: ProbeAccountReadings): ClaudeProbeSample[] {
  const indexed = readings ? { rows: readings.rows.slice(-MAX_PROBE_ROWS).reverse() }
    : readPreparedProbeAccountRows(sqlite, "claude", subscription, { index: "resolved", limit: MAX_PROBE_ROWS });
  if (!indexed) throw new ProbeAccountIndexUnavailable();
  const rows: Array<ClaudeProbeSample & { extra?: string | null }> = indexed.rows.map(row => ({
    ts: row.ts, kind: row.kind, scope_label: row.scope as string | null,
    percent: row.used_percent as number, resets_at: row.resets_at as string | null,
    extra: row.extra as string | null,
  }));
  const kept: ClaudeProbeSample[] = [];
  // Kept resets per counter with their parsed instants: `sameResetWindow` without parsing them for every row.
  const keptResets = new Map<string, Array<{ reset: string | null; ms: number }>>();
  const sameWindow = (other: { reset: string | null; ms: number }, reset: string | null, ms: number) =>
    !other.reset || !reset || !Number.isFinite(other.ms) || !Number.isFinite(ms) ? other.reset === reset : Math.abs(other.ms - ms) <= RESET_TOLERANCE_MS;
  for (const row of rows) {
    const counter = JSON.stringify([row.kind, row.scope_label ?? null]), resetMs = row.resets_at ? Date.parse(row.resets_at) : NaN;
    const resets = keptResets.get(counter) ?? [];
    if (resets.some(other => sameWindow(other, row.resets_at, resetMs))) continue;
    resets.push({ reset: row.resets_at, ms: resetMs });
    keptResets.set(counter, resets);
    const share = claudeCodeProductShareFromExtra(row.extra);
    const breakdown = claudeProductBreakdownFromExtra(row.extra);
    const sample: ClaudeProbeSample = {
      ts: row.ts,
      kind: row.kind,
      scope_label: row.scope_label,
      percent: row.percent,
      resets_at: row.resets_at,
    };
    const accountWeekly = row.kind === "weekly_all" && row.scope_label == null
      && Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100;
    if (share && accountWeekly && coherentShareWindow(share, row.resets_at)) sample.product_share = share;
    if (breakdown && accountWeekly && coherentShareWindow(breakdown, row.resets_at)) sample.product_breakdown = breakdown;
    kept.push(sample);
  }
  return kept.reverse();
}
