import fs from "fs";
import os from "os";
import path from "path";
import type { Database } from "bun:sqlite";
import { persistProbeWindows, probeTarget, runProbeCycle as runCoreProbeCycle } from "../core/probe";
import { ProviderProbeError, type ProbeCycleOptions, type ProviderProbeAdapter, type WindowReading } from "../types";
import { ProbeAccountIndexUnavailable, preparedProbeAccountIndexReady, readPreparedProbeAccountRows } from "../../server/current/probe-account-reader";
import { readCurrentSubject } from "../../server/current/store";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const TIMEOUT_MS = 8_000;
export interface GlmCredentials {
  key: string;
  provider: string;
}
export function glmAuthPath(file?: string): string {
  if (file) return file;
  const env = process.env.TOKENATLAS_GLM_AUTH;
  if (env) return env;
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}
export function readGlmKey(file?: string): { creds: GlmCredentials | null; error: string | null } {
  const target = glmAuthPath(file);
  if (!fs.existsSync(target)) {
    return { creds: null, error: `brak pliku poświadczeń opencode (${target})` };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    return { creds: null, error: `poświadczenia nieczytelne: ${(error as Error).message}` };
  }
  for (const provider of ["zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai"]) {
    const entry = raw[provider] as { key?: string } | undefined;
    if (entry?.key) return { creds: { key: entry.key, provider }, error: null };
  }
  return { creds: null, error: "auth.json bez wpisu z.ai (zai-coding-plan)" };
}
export interface GlmProbeWindow {
  kind: string;
  window_hours: number | null;
  allowance: number | null;
  used: number;
  remaining: number | null;
  percent: number;
  vendor_percent: number | null;
  resets_at: string | null;
}
export interface GlmProbeResult {
  subscription: string;
  ts: string;
  level: string | null;
  windows: GlmProbeWindow[];
  error: string | null;
}
interface RawLimit {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
}
interface RawQuota {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { limits?: RawLimit[]; level?: string } | null;
}
const UNIT_HOURS: Record<number, number> = { 3: 1, 6: 168 };
export function parseQuotaPayload(data: RawQuota): { windows: GlmProbeWindow[]; level: string | null } {
  const limits = data.data?.limits;
  const level = data.data?.level ?? null;
  if (!Array.isArray(limits)) return { windows: [], level };
  const windows: GlmProbeWindow[] = [];
  for (const limit of limits) {
    const used = typeof limit?.currentValue === "number" ? limit.currentValue : null;
    if (used == null) continue;
    const unitHours = typeof limit.unit === "number" ? UNIT_HOURS[limit.unit] : undefined;
    const hours = unitHours != null && typeof limit.number === "number" ? unitHours * limit.number : null;
    const allowance = typeof limit.usage === "number" && limit.usage > 0 ? limit.usage : null;
    windows.push({
      kind: hours == null ? `unit${limit.unit ?? "?"}x${limit.number ?? "?"}` : hours <= 24 ? "session" : "weekly",
      window_hours: hours,
      allowance,
      used,
      remaining: typeof limit.remaining === "number" ? limit.remaining : null,
      percent: allowance != null ? (used / allowance) * 100 : (limit.percentage ?? 0),
      vendor_percent: typeof limit.percentage === "number" ? limit.percentage : null,
      resets_at: typeof limit.nextResetTime === "number" && limit.nextResetTime > 0
        ? new Date(limit.nextResetTime).toISOString()
        : null,
    });
  }
  return { windows, level };
}
interface GlmTarget {
  subscription: string;
  file?: string;
}
type GlmReading = WindowReading;
interface GlmMeta {
  level: string | null;
  windows: GlmProbeWindow[];
}
export const glmProbeAdapter: ProviderProbeAdapter<
  GlmTarget,
  GlmCredentials,
  RawQuota,
  GlmReading,
  GlmMeta,
  GlmProbeSample
> = {
  id: "glm",
  capabilities: {
    reportsPercent: "used",
    reportsAllowance: true,
    unit: "credits",
    windows: "multiple",
    targetConcurrency: "parallel",
  },
  subject: (target) => target.subscription,
  credentials: (target) => readGlmKey(target.file),
  async request(_target, { credentials, fetchJson }) {
    const response = await fetchJson<RawQuota>(
      QUOTA_URL,
      {
        method: "GET",
        headers: {
          Authorization: credentials.key,
          "Accept-Language": "en-US,en",
          "Content-Type": "application/json",
        },
      },
      TIMEOUT_MS,
      `brak odpowiedzi w ${TIMEOUT_MS} ms`
    );
    if (response.status === 401 || response.status === 403) {
      throw new ProviderProbeError(`konto odrzuciło odczyt (HTTP ${response.status})`);
    }
    if (!response.ok || !response.body) throw new ProviderProbeError(`HTTP ${response.status}`);
    if (response.body.success === false ||
        (typeof response.body.code === "number" && response.body.code !== 200)) {
      throw new ProviderProbeError(response.body.msg || `kod ${response.body.code}`);
    }
    return response.body;
  },
  parse(raw) {
    const parsed = parseQuotaPayload(raw);
    return {
      readings: parsed.windows.map((window) => ({
        kind: window.kind,
        group: null,
        scope: null,
        plan: parsed.level,
        reportedPercentSide: "used" as const,
        usedPercent: window.allowance != null ? window.percent : window.vendor_percent,
        remainingPercent: null,
        allowance: window.allowance,
        used: window.used,
        remaining: window.remaining,
        vendorPercent: window.vendor_percent,
        windowMinutes: window.window_hours == null ? null : window.window_hours * 60,
        resetsAt: window.resets_at,
        rateLimitReached: null,
        resetCredits: null,
        profile: null,
        ok: null,
        error: null,
        extra: null,
      })),
      meta: { level: parsed.level, windows: parsed.windows },
    };
  },
  validate: ({ readings }) => readings.length === 0 ? "odpowiedź bez rozpoznanych okien" : null,
  persist(sqlite, readings, context) {
    return persistProbeWindows(sqlite, "glm", context.target.subscription, context.ts, readings);
  },
  read: (sqlite, subscription) => readGlmProbe(sqlite, subscription),
};
export async function probeGlmQuota(subscription: string, file?: string): Promise<GlmProbeResult> {
  const outcome = await probeTarget(glmProbeAdapter, { subscription, file });
  return {
    subscription,
    ts: outcome.ts,
    level: outcome.meta?.level ?? null,
    windows: outcome.meta?.windows ?? [],
    error: outcome.error,
  };
}
export interface GlmProbeCycleResult {
  ts: string;
  rows: number;
  error: string | null;
}
export async function runGlmProbeCycle(
  sqlite: Database,
  subscription: string,
  file?: string,
  options?: ProbeCycleOptions
): Promise<GlmProbeCycleResult> {
  const cycle = await runCoreProbeCycle(sqlite, glmProbeAdapter, [{ subscription, file }], options);
  const outcome = cycle.outcomes[0]!;
  return { ts: outcome.ts, rows: outcome.rows, error: outcome.error };
}
export interface GlmProbeSample extends GlmProbeWindow {
  ts: string;
  level: string | null;
}
export function readGlmProbe(sqlite: Database, subscription: string): GlmProbeSample[] {
  if (!preparedProbeAccountIndexReady(sqlite, "glm", subscription)) throw new ProbeAccountIndexUnavailable();
  const published = readCurrentSubject(sqlite, "glm", subscription) as { __keys?: Record<string, true> } | null;
  const kinds = new Set(Object.keys(published?.__keys ?? {}).flatMap(key => {
    const tuple = JSON.parse(key) as unknown[];
    return tuple[0] === "glm" && tuple[1] === subscription.toLowerCase() ? [String(tuple[2])] : [];
  }));
  const samples: GlmProbeSample[] = [];
  for (const kind of kinds) {
    const head = readPreparedProbeAccountRows(sqlite, "glm", subscription, { index: "glm-kind", kind, limit: 1 });
    if (!head) throw new ProbeAccountIndexUnavailable();
    if (!head.rows.length) continue;
    const ties = readPreparedProbeAccountRows(sqlite, "glm", subscription,
      { index: "glm-kind", kind, timestamp: head.rows[0]!.ts, limit: 513 });
    if (!ties || ties.rows.length > 512) throw new ProbeAccountIndexUnavailable();
    for (const row of ties.rows) samples.push({ ts: row.ts, level: row.plan as string | null, kind: row.kind,
      window_hours: (row.window_minutes as number) / 60, allowance: row.allowance as number,
      used: row.used as number, remaining: row.remaining as number,
      percent: (row.used_percent as number | null) ?? 0, vendor_percent: row.vendor_percent as number | null,
      resets_at: row.resets_at as string | null });
  }
  return samples.sort((a,b) => (a.window_hours ?? 0) - (b.window_hours ?? 0));
}
if (import.meta.main) {
  const subscription = process.argv[2] || "glm";
  const result = await probeGlmQuota(subscription);
  console.log(JSON.stringify(result, null, 2));
}
