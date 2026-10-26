import fs from "fs";
import os from "os";
import path from "path";
import type { Database } from "bun:sqlite";
import { persistProbeWindows, runProbeCycle as runCoreProbeCycle } from "../core/probe";
import { ProviderProbeError, type ProbeCycleOptions, type ProviderProbeAdapter, type WindowReading } from "../types";
import { ProbeAccountIndexUnavailable, readPreparedProbeAccountRows } from "../../server/current/probe-account-reader";
interface GrokLogSource {
  file: string;
}
interface GrokTarget {
  subscription: string;
  home?: string;
  resolveAt?: (sourceTs: string) => string | null;
}
interface Cent {
  val?: number | string;
}
interface RawBillingConfig {
  creditUsagePercent?: number;
  currentPeriod?: {
    type?: string;
    start?: string;
    end?: string;
  } | null;
  monthlyLimit?: Cent | null;
  used?: Cent | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  isUnifiedBillingUser?: boolean | null;
}
export interface RawGrokBilling {
  config?: RawBillingConfig | null;
  onDemandEnabled?: boolean | null;
  subscriptionTier?: string | null;
}
interface GrokMeta {
  plan: string | null;
  source_ts: string;
}
interface GrokLogSnapshot {
  ts: string;
  billing: RawGrokBilling;
}
export interface GrokProbeSample {
  ts: string;
  plan: string | null;
  kind: string;
  percent: number;
  window_minutes: number | null;
  resets_at: string | null;
  period_start: string | null;
  period_type: string | null;
}
function grokHome(home?: string): string {
  return home || process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}
export function grokUnifiedLogPath(home?: string): string {
  return path.join(grokHome(home), "logs", "unified.jsonl");
}
function readLatestGrokBillingFile(file: string, maxBytes: number): GrokLogSnapshot | null {
  if (!fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer.toString("utf-8").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.msg !== "billing: fetched credits config" || typeof entry.ts !== "string") continue;
      if (entry.ctx == null || typeof entry.ctx !== "object" || Array.isArray(entry.ctx)) continue;
      return { ts: entry.ts, billing: entry.ctx as RawGrokBilling };
    } catch {
    }
  }
  return null;
}
export function readLatestGrokBilling(home?: string, maxBytes = 4 * 1024 * 1024): GrokLogSnapshot | null {
  return readLatestGrokBillingFile(grokUnifiedLogPath(home), maxBytes);
}
function finiteNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}
function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function periodKind(periodType: string | null): string {
  if (/weekly/i.test(periodType ?? "")) return "weekly";
  if (/monthly/i.test(periodType ?? "")) return "monthly";
  return "billing";
}
export function parseGrokBilling(data: RawGrokBilling): WindowReading[] {
  const config = data.config;
  if (!config) return [];
  const allowance = finiteNumber(config.monthlyLimit?.val);
  const used = finiteNumber(config.used?.val);
  const reportedPercent = finiteNumber(config.creditUsagePercent);
  const percent = reportedPercent ?? (allowance != null && allowance > 0 && used != null ? (used / allowance) * 100 : null);
  if (percent == null) return [];
  const periodType = config.currentPeriod?.type ?? null;
  const periodStart = canonicalIso(config.currentPeriod?.start ?? config.billingPeriodStart);
  const periodEnd = canonicalIso(config.currentPeriod?.end ?? config.billingPeriodEnd);
  const startMs = periodStart == null ? NaN : new Date(periodStart).getTime();
  const endMs = periodEnd == null ? NaN : new Date(periodEnd).getTime();
  const windowMinutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? (endMs - startMs) / 60_000
    : null;
  return [{
    kind: periodKind(periodType),
    group: "subscription",
    scope: null,
    plan: data.subscriptionTier ?? null,
    reportedPercentSide: "used",
    usedPercent: percent,
    remainingPercent: null,
    allowance,
    used,
    remaining: allowance != null && used != null ? Math.max(0, allowance - used) : null,
    vendorPercent: reportedPercent,
    windowMinutes,
    resetsAt: periodEnd,
    rateLimitReached: percent >= 100,
    resetCredits: null,
    profile: null,
    ok: true,
    error: null,
    extra: {
      period_start: periodStart,
      period_type: periodType,
      unified_billing_user: config.isUnifiedBillingUser ?? null,
      on_demand_enabled: data.onDemandEnabled ?? null,
      legacy_derived_percent: reportedPercent == null,
    },
  }];
}
export const grokProbeAdapter: ProviderProbeAdapter<
  GrokTarget,
  GrokLogSource,
  GrokLogSnapshot,
  WindowReading,
  GrokMeta,
  GrokProbeSample
> = {
  id: "grok",
  capabilities: {
    reportsPercent: "used",
    reportsAllowance: true,
    unit: "usd_cents",
    windows: "single",
    targetConcurrency: "parallel",
  },
  subject: (target) => target.subscription,
  credentials: (target) => {
    const file = grokUnifiedLogPath(target.home);
    return fs.existsSync(file)
      ? { creds: { file }, error: null }
      : { creds: null, error: `brak logu Groka (${file})` };
  },
  async request(_target, { credentials }) {
    const snapshot = readLatestGrokBillingFile(credentials.file, 4 * 1024 * 1024);
    if (!snapshot) throw new ProviderProbeError("log Groka nie zawiera jeszcze odczytu Billing — uruchom `/usage`");
    return snapshot;
  },
  parse(raw) {
    return {
      readings: parseGrokBilling(raw.billing),
      meta: { plan: raw.billing.subscriptionTier ?? null, source_ts: raw.ts },
    };
  },
  validate(parsed) {
    return parsed.readings.length > 0 ? null : "Billing Groka nie zwrócił procentu użycia";
  },
  persist(sqlite, readings, context) {
    const source = grokHome(context.target.home);
    const subscription = context.target.resolveAt
      ? context.target.resolveAt(context.meta.source_ts)
      : context.target.subscription;
    if (subscription == null) {
      // The Billing snapshot is real but no era owns this machine's Grok home
      // right now. Silently dropping it left the card with "0%"; an error row
      // gives the roster a reason it can show.
      return persistProbeWindows(sqlite, "grok", context.target.subscription, context.ts, [{
        kind: "error",
        group: "-",
        scope: null,
        plan: null,
        reportedPercentSide: "used",
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
        profile: null,
        ok: false,
        error: `żadna era nie obejmuje dziś źródła ${source} — zadeklaruj home tej maszyny w accounts.json`,
        extra: { home: source },
      }]);
    }
    const seen = sqlite
      .query(
        `SELECT 1 FROM probe_windows
          WHERE provider = 'grok' AND ts = ?
            AND (json_extract(extra, '$.home') = ? OR json_extract(extra, '$.home') IS NULL)
          LIMIT 1`
      )
      .get(context.meta.source_ts, source);
    if (seen) return 0;
    return persistProbeWindows(
      sqlite,
      "grok",
      subscription,
      context.meta.source_ts,
      readings.map((reading) => ({
        ...reading,
        extra: { ...(reading.extra ?? {}), home: source },
      }))
    );
  },
  read: (sqlite, subject) => {
    const sample = readGrokProbe(sqlite, subject);
    return sample ? [sample] : [];
  },
};
export async function runGrokProbeCycle(
  sqlite: Database,
  subscription = "grok",
  home?: string,
  options?: ProbeCycleOptions,
  resolveAt?: (sourceTs: string) => string | null
): Promise<{ ts: string; rows: number; error: string | null }> {
  const cycle = await runCoreProbeCycle(
    sqlite,
    grokProbeAdapter,
    [{ subscription, home, resolveAt }],
    options
  );
  const outcome = cycle.outcomes[0]!;
  return { ts: outcome.ts, rows: outcome.rows, error: outcome.error };
}
export function readGrokProbe(sqlite: Database, subscription = "grok"): GrokProbeSample | null {
  let row: {
    ts: string;
    plan: string | null;
    kind: string;
    percent: number;
    window_minutes: number | null;
    resets_at: string | null;
    extra: string | null;
  } | null;
  const indexed = readPreparedProbeAccountRows(sqlite, "grok", subscription, { index: "grok-percent", limit: 1 });
  if (!indexed) throw new ProbeAccountIndexUnavailable();
  const found = indexed.rows[0];
  row = found ? { ts: found.ts, plan: found.plan as string | null, kind: found.kind,
    percent: found.used_percent as number, window_minutes: found.window_minutes as number | null,
    resets_at: found.resets_at as string | null, extra: found.extra as string | null } : null;
  if (!row) return null;
  let extra: Record<string, unknown> = {};
  try {
    extra = row.extra ? JSON.parse(row.extra) as Record<string, unknown> : {};
  } catch {
    extra = {};
  }
  return {
    ts: row.ts,
    plan: row.plan,
    kind: row.kind,
    percent: row.percent,
    window_minutes: row.window_minutes,
    resets_at: row.resets_at,
    period_start: typeof extra.period_start === "string" ? extra.period_start : null,
    period_type: typeof extra.period_type === "string" ? extra.period_type : null,
  };
}
