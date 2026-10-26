import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { persistProbeWindows, probeTarget, runProbeCycle as runCoreProbeCycle } from "../core/probe";
import { ProviderProbeError, type ProbeCycleOptions, type ProviderProbeAdapter, type WindowReading } from "../types";
import { loadAccountResolver } from "../../server/account-resolver";
import { ProbeAccountIndexUnavailable, readPreparedProbeTimestamp } from "../../server/current/probe-account-reader";
const POOL_DIR = "C:\\Users\\Public\\agy";
const POOL_FILE = path.join(POOL_DIR, "pool.json");
const TOKEN_FILE = path.join(POOL_DIR, "worker-token.txt");
const ASKED_MODEL = "Gemini 3.7 Flash (High)";
const HEALTH_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 200_000;
export interface PoolAccount {
  id: string;
  profile: string;
  port: number;
  google?: string;
}
export interface QuotaRow {
  limit_group: string;
  kind: string;
  remaining_percent: number;
  resets_at: string | null;
}
export interface GeminiProbeResult {
  account: string;
  profile: string;
  ts: string;
  rows: QuotaRow[];
  fingerprint: string | null;
  error: string | null;
}
export function loadPool(): PoolAccount[] {
  try {
    const raw = JSON.parse(fs.readFileSync(POOL_FILE, "utf8")) as { accounts?: PoolAccount[] };
    return (raw.accounts ?? []).filter((account) => account && account.id && account.port);
  } catch {
    return [];
  }
}
function poolToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}
export function usedPercentOf(remainingPercent: number): number {
  return Math.max(0, Math.min(100, 100 - remainingPercent));
}
export function parseQuotaTable(text: string): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^(.+?)\t(.+?)\t(\d+)%\t(\S+)/);
    if (!match) continue;
    const [, group, label, percentage, reset] = match;
    const kind = /weekly/i.test(label!)
      ? "weekly"
      : /five\s*hour/i.test(label!) ? "five_hour" : label!.trim();
    rows.push({
      limit_group: group!.trim(),
      kind,
      remaining_percent: Number(percentage),
      resets_at: reset ?? null,
    });
  }
  return rows;
}
interface GeminiCredentials {
  token: string | null;
}
type GeminiReading = WindowReading;
interface GeminiMeta {
  rows: QuotaRow[];
  fingerprint: string | null;
}
export const geminiProbeAdapter: ProviderProbeAdapter<
  PoolAccount,
  GeminiCredentials,
  string,
  GeminiReading,
  GeminiMeta
> = {
  id: "gemini",
  capabilities: {
    reportsPercent: "remaining",
    reportsAllowance: false,
    unit: "percent",
    windows: "model-family",
    targetConcurrency: "sequential",
  },
  subject: (account) => account.id,
  credentials: () => ({ creds: { token: poolToken() }, error: null }),
  async request(account, { credentials, fetchJson }) {
    const headers: Record<string, string> = credentials.token
      ? { authorization: `Bearer ${credentials.token}` }
      : {};
    try {
      const health = await fetchJson<unknown>(
        `http://127.0.0.1:${account.port}/health`,
        { headers },
        HEALTH_TIMEOUT_MS,
        `timeout po ${Math.round(HEALTH_TIMEOUT_MS / 1000)} s`
      );
      if (!health.ok) throw new ProviderProbeError(`HTTP ${health.status}`);
    } catch (error) {
      throw new ProviderProbeError(`worker nie odpowiada: ${error instanceof Error ? error.message : String(error)}`);
    }
    let quotaBody: unknown;
    try {
      const quota = await fetchJson<unknown>(
        `http://127.0.0.1:${account.port}/quota?model=${encodeURIComponent(ASKED_MODEL)}`,
        { headers },
        QUOTA_TIMEOUT_MS,
        `timeout po ${Math.round(QUOTA_TIMEOUT_MS / 1000)} s`
      );
      if (!quota.ok) throw new ProviderProbeError(`HTTP ${quota.status}`);
      quotaBody = quota.body;
    } catch (error) {
      throw new ProviderProbeError(`odczyt /quota nieudany: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const body = quotaBody as { stdout?: string };
      return (JSON.parse(String(body?.stdout ?? "").trim()) as { response?: string }).response ?? "";
    } catch {
      throw new ProviderProbeError(
        "nie da się odczytać tabeli limitów (worker żyje, ale CLI nie odpowiedziało tabelą)"
      );
    }
  },
  parse(table) {
    const rows = parseQuotaTable(table);
    const weeklyGemini = rows.find((row) => /^gemini/i.test(row.limit_group) && row.kind === "weekly");
    return {
      readings: rows.map((row) => ({
        kind: row.kind,
        group: row.limit_group,
        scope: ASKED_MODEL,
        plan: null,
        reportedPercentSide: "remaining" as const,
        usedPercent: usedPercentOf(row.remaining_percent),
        remainingPercent: row.remaining_percent,
        allowance: null,
        used: null,
        remaining: null,
        vendorPercent: row.remaining_percent,
        windowMinutes: null,
        resetsAt: row.resets_at,
        rateLimitReached: null,
        resetCredits: null,
        profile: null,
        ok: true,
        error: null,
        extra: null,
      })),
      meta: { rows, fingerprint: weeklyGemini?.resets_at ?? null },
    };
  },
  validate: ({ readings }) => readings.length === 0
    ? "tabela limitów pusta - najczęściej wygasły login w tym profilu"
    : null,
  persist(sqlite, readings, context) {
    const withProfile = readings.map((reading) => ({ ...reading, profile: context.target.profile }));
    return persistProbeWindows(sqlite, "gemini", context.target.id, context.ts, withProfile);
  },
  persistError(sqlite, context) {
    return persistProbeWindows(sqlite, "gemini", context.target.id, context.ts, [{
      kind: "error",
      group: "-",
      scope: ASKED_MODEL,
      plan: null,
      reportedPercentSide: "remaining",
      usedPercent: null,
      remainingPercent: null,
      allowance: null,
      used: null,
      remaining: null,
      vendorPercent: null,
      windowMinutes: null,
      resetsAt: null,
      rateLimitReached: null,
      resetCredits: null,
      profile: context.target.profile,
      ok: false,
      error: context.error,
      extra: null,
    }]);
  },
};
export async function probeAccount(account: PoolAccount): Promise<GeminiProbeResult> {
  const outcome = await probeTarget(geminiProbeAdapter, account);
  return {
    account: account.id,
    profile: account.profile,
    ts: outcome.ts,
    rows: outcome.meta?.rows ?? [],
    fingerprint: outcome.meta?.fingerprint ?? null,
    error: outcome.error,
  };
}
export interface GeminiCycleResult {
  ts: string;
  probed: number;
  rows: number;
  errors: Array<{ account: string; error: string }>;
  collisions: Record<string, string[]>;
}
export function fingerprintCollisions(results: GeminiProbeResult[]): Record<string, string[]> {
  const byFingerprint = new Map<string, string[]>();
  for (const result of results) {
    if (!result.fingerprint) continue;
    const accounts = byFingerprint.get(result.fingerprint) ?? [];
    accounts.push(result.account);
    byFingerprint.set(result.fingerprint, accounts);
  }
  const collisions: Record<string, string[]> = {};
  for (const [fingerprint, accounts] of byFingerprint) {
    if (accounts.length > 1) collisions[fingerprint] = accounts;
  }
  return collisions;
}
export async function runGeminiProbeCycle(
  sqlite: Database,
  accounts: PoolAccount[],
  options?: ProbeCycleOptions
): Promise<GeminiCycleResult> {
  const cycle = await runCoreProbeCycle(sqlite, geminiProbeAdapter, accounts, options);
  const results: GeminiProbeResult[] = cycle.outcomes.map((outcome) => ({
    account: outcome.target.id,
    profile: outcome.target.profile,
    ts: outcome.ts,
    rows: outcome.meta?.rows ?? [],
    fingerprint: outcome.meta?.fingerprint ?? null,
    error: outcome.error,
  }));
  return {
    ts: cycle.ts,
    probed: cycle.probed,
    rows: cycle.rows,
    errors: cycle.errors,
    collisions: fingerprintCollisions(results),
  };
}
export interface GeminiAccountState {
  account: string;
  profile: string | null;
  ts: string;
  age_minutes: number;
  windows: Array<QuotaRow & { used_percent: number }>;
  fingerprint: string | null;
  ok: boolean;
  error: string | null;
}
export function latestGeminiState(sqlite: Database): GeminiAccountState[] {
  let rows: Array<{
    account: string;
    profile: string | null;
    ts: string;
    limit_group: string;
    kind: string;
    remaining_percent: number;
    resets_at: string | null;
    ok: number;
    error: string | null;
  }>;
  rows = [];
  for (const account of loadAccountResolver(sqlite).accounts("gemini")) {
    const latest = readPreparedProbeTimestamp(sqlite, "gemini", account, "resolved");
    if (!latest) throw new ProbeAccountIndexUnavailable();
    for (const sample of latest.rows) rows.push({ account, profile: sample.profile as string | null,
      ts: sample.ts, limit_group: sample.limit_group as string, kind: sample.kind,
      remaining_percent: sample.remaining_percent as number, resets_at: sample.resets_at as string | null,
      ok: sample.ok as number, error: sample.error as string | null });
  }
  rows.sort((a,b) => a.account.localeCompare(b.account) || a.limit_group.localeCompare(b.limit_group) || a.kind.localeCompare(b.kind));
  const byAccount = new Map<string, GeminiAccountState>();
  const now = Date.now();
  for (const row of rows) {
    let state = byAccount.get(row.account);
    if (!state) {
      state = {
        account: row.account,
        profile: row.profile,
        ts: row.ts,
        age_minutes: Math.max(0, (now - new Date(row.ts).getTime()) / 60_000),
        windows: [],
        fingerprint: null,
        ok: true,
        error: null,
      };
      byAccount.set(row.account, state);
    }
    if (row.ok === 0) {
      state.ok = false;
      state.error = row.error;
      continue;
    }
    state.windows.push({
      limit_group: row.limit_group,
      kind: row.kind,
      remaining_percent: row.remaining_percent,
      resets_at: row.resets_at,
      used_percent: usedPercentOf(row.remaining_percent),
    });
    if (/^gemini/i.test(row.limit_group) && row.kind === "weekly") state.fingerprint = row.resets_at;
  }
  return [...byAccount.values()];
}
export function poolHeadroom(
  states: GeminiAccountState[],
  group = "Gemini"
): { account: string; remaining: number } | null {
  let best: { account: string; remaining: number } | null = null;
  for (const state of states) {
    if (!state.ok) continue;
    const windows = state.windows.filter((window) => new RegExp(`^${group}`, "i").test(window.limit_group));
    if (windows.length === 0) continue;
    const weakest = Math.min(...windows.map((window) => window.remaining_percent));
    if (!best || weakest > best.remaining) best = { account: state.account, remaining: weakest };
  }
  return best;
}
