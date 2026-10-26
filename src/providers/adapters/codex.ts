import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "node:os";
import { readCodexAccountIdentity, type CodexIdentityEvidence } from "../codex-identity";
import type { Database } from "bun:sqlite";
import type { IdentityRead } from "../core/identity";
import { persistProbeWindows, probeTarget, runProbeCycle as runCoreProbeCycle } from "../core/probe";
import { ProviderProbeError, type ProbeCycleOptions, type ProviderProbeAdapter, type WindowReading } from "../types";
import { CODEX_CREDITS_BALANCE, CODEX_CREDITS_HAS, CODEX_CREDITS_UNLIMITED, CODEX_RESET_CREDITS } from "../../shared/credit-pools";
const PROBE_METHOD = "account/rateLimits/read" as const;
export interface ProbeWindow {
  slot: "primary" | "secondary";
  used_percent: number;
  window_minutes: number | null;
  resets_at: number | null;
}
export interface ProbeLimit {
  limit_id: string;
  limit_name: string | null;
  plan_type: string | null;
  rate_limit_reached: boolean;
  reset_credits: number;
  windows: ProbeWindow[];
}
export interface ProbeResult {
  account: string;
  home: string;
  ts: string;
  limits: ProbeLimit[];
  error: string | null;
}
interface RawWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}
interface RawSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: RawWindow | null;
  secondary?: RawWindow | null;
  rateLimitReachedType?: string | null;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
}
interface RawResetCredit {
  id?: string;
  status?: string | null;
  grantedAt?: number | null;
  expiresAt?: number | null;
  title?: string | null;
}
interface RawResponse {
  rateLimits?: RawSnapshot;
  rateLimitsByLimitId?: Record<string, RawSnapshot> | null;
  rateLimitResetCredits?: { availableCount?: number; credits?: RawResetCredit[] | null } | null;
}
interface ProtocolMessage {
  id?: number;
  result?: RawResponse;
  error?: { message?: string };
}
function toWindows(snapshot: RawSnapshot): ProbeWindow[] {
  const windows: ProbeWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const raw = snapshot[slot];
    if (!raw || typeof raw.usedPercent !== "number") continue;
    windows.push({
      slot,
      used_percent: raw.usedPercent,
      window_minutes: raw.windowDurationMins ?? null,
      resets_at: raw.resetsAt ?? null,
    });
  }
  return windows;
}
export interface ProbeTarget {
  identity?: CodexIdentityEvidence;
  account: string;
  home: string;
}
interface CodexTarget extends ProbeTarget {
  timeoutMs?: number;
}
interface CodexCredentials {
  home: string;
}
type CodexReading = WindowReading;
interface CodexMeta {
  limits: ProbeLimit[];
}
export function codexProbeCommand(
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = command => Bun.which(command)
): { command: string; shell: boolean } {
  // A broken npm shim can shadow the desktop installation on Windows PATH.
  // Launch the native binary directly when available, also avoiding orphaned shells.
  const native = which(platform === "win32" ? "codex.exe" : "codex");
  return { command: native ?? "codex", shell: native == null && platform === "win32" };
}
function readRateLimits(home: string, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const launch = codexProbeCommand();
      child = spawn(launch.command, ["app-server"], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
        shell: launch.shell,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (error: Error | null, response?: RawResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      if (error) reject(error);
      else resolve(response ?? {});
    };
    const timer = setTimeout(
      () => finish(new ProviderProbeError(`timeout po ${timeoutMs} ms`)),
      timeoutMs
    );
    let buffer = "";
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: ProtocolMessage;
        try {
          message = JSON.parse(line) as ProtocolMessage;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new ProviderProbeError(message.error.message || "Codex initialization failed"));
            return;
          }
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
          child.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: PROBE_METHOD, params: {} }) + "\n"
          );
        } else if (message.id === 2) {
          if (message.error) {
            finish(new ProviderProbeError(message.error.message || `${PROBE_METHOD} failed`));
          } else {
            finish(null, message.result ?? {});
          }
        }
      }
    });
    child.on("error", (error: Error) => finish(error));
    child.stdin?.on("error", (error: Error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new ProviderProbeError(stderr.includes("Missing optional dependency @openai/codex")
        ? "Codex CLI installation is incomplete; reinstall the CLI or expose codex.exe on PATH"
        : `app-server zakończył się kodem ${code} bez odpowiedzi`));
    });
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "tokenAtlas", version: "0.9" } },
      }) + "\n"
    );
  });
}
const isoOfSeconds = (value: number | null | undefined): string | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
/**
 * The account's credit balance and free limit resets, as reading extra (see shared/credit-pools). The
 * balance is kept as the vendor's decimal text; the snapshot of the `codex` limit carries it, others send null.
 * A reset keeps only what its accounting needs: id, dates and a status other than available.
 */
export function codexCreditExtra(raw: RawResponse): Record<string, string | boolean> {
  const extra: Record<string, string | boolean> = {};
  const snapshots = [raw.rateLimits, ...Object.values(raw.rateLimitsByLimitId ?? {})];
  const credits = snapshots.find(snapshot => snapshot?.credits != null)?.credits;
  if (credits) {
    if (typeof credits.hasCredits === "boolean") extra[CODEX_CREDITS_HAS] = credits.hasCredits;
    if (typeof credits.unlimited === "boolean") extra[CODEX_CREDITS_UNLIMITED] = credits.unlimited;
    if (typeof credits.balance === "string" && credits.balance !== "") extra[CODEX_CREDITS_BALANCE] = credits.balance;
  }
  const items = raw.rateLimitResetCredits?.credits;
  if (Array.isArray(items)) extra[CODEX_RESET_CREDITS] = JSON.stringify(items
    .filter(item => typeof item?.id === "string")
    .map(item => ({ id: item.id, granted_at: isoOfSeconds(item.grantedAt), expires_at: isoOfSeconds(item.expiresAt),
      ...(item.status != null && item.status !== "available" ? { status: item.status } : {}) }))
    .sort((a, b) => a.id!.localeCompare(b.id!)));
  return extra;
}
export const codexProbeAdapter: ProviderProbeAdapter<
  CodexTarget,
  CodexCredentials,
  RawResponse,
  CodexReading,
  CodexMeta
> = {
  id: "codex",
  capabilities: {
    reportsPercent: "used",
    reportsAllowance: false,
    unit: "percent",
    windows: "multiple",
    targetConcurrency: "parallel",
  },
  subject: (target) => target.account,
  credentials: (target) => target.identity && readCodexAccountIdentity(target.home).identity?.key !== target.identity.key
    ? { creds: null, error: "ChatGPT login changed or is unreadable; waiting for account discovery" }
    : { creds: { home: target.home }, error: null },
  request: (target, { credentials }) => readRateLimits(credentials.home, target.timeoutMs ?? 30_000),
  parse(raw) {
    const credits = raw.rateLimitResetCredits?.availableCount ?? 0;
    const creditExtra = codexCreditExtra(raw);
    const snapshots = raw.rateLimitsByLimitId
      ? Object.values(raw.rateLimitsByLimitId)
      : raw.rateLimits ? [raw.rateLimits] : [];
    const limits: ProbeLimit[] = snapshots.map((snapshot) => ({
      limit_id: snapshot.limitId ?? "?",
      limit_name: snapshot.limitName ?? null,
      plan_type: snapshot.planType ?? null,
      rate_limit_reached: snapshot.rateLimitReachedType != null,
      reset_credits: credits,
      windows: toWindows(snapshot),
    }));
    const readings: CodexReading[] = [];
    for (const limit of limits) {
      for (const window of limit.windows) {
        readings.push({
          kind: window.slot,
          group: limit.limit_id,
          scope: limit.limit_name,
          plan: limit.plan_type,
          reportedPercentSide: "used",
          usedPercent: window.used_percent,
          remainingPercent: null,
          allowance: null,
          used: null,
          remaining: null,
          vendorPercent: window.used_percent,
          windowMinutes: window.window_minutes,
          resetsAt: window.resets_at == null ? null : new Date(window.resets_at * 1000).toISOString(),
          rateLimitReached: limit.rate_limit_reached,
          resetCredits: limit.reset_credits,
          profile: null,
          ok: null,
          error: null,
          extra: null,
        });
      }
    }
    // The account's credits ride on one row per reading, the `codex` counter's (else the first): every row
    // of a reading shares one instant, so copies would only repeat the same fact.
    const carrier = readings.find(reading => reading.group === "codex") ?? readings[0];
    if (carrier && Object.keys(creditExtra).length > 0) carrier.extra = creditExtra;
    return { readings, meta: { limits } };
  },
  validate: ({ meta }) => meta.limits.length === 0 ? "odpowiedź bez liczników" : null,
  persist(sqlite, readings, context) {
    if (context.target.identity && readCodexAccountIdentity(context.target.home).identity?.key !== context.target.identity.key)
      throw new ProviderProbeError("ChatGPT login changed during the limit read; sample discarded");
    const withHome = readings.map((reading) => ({ ...reading, extra: { ...reading.extra, home: context.target.home,
      ...(context.target.identity ? { codex_account: JSON.stringify(context.target.identity) } : {}) } }));
    return persistProbeWindows(sqlite, "codex", context.target.account, context.ts, withHome);
  },
  // A failed probe leaves a row too, so "no reading" has a visible reason on
  // every machine instead of a console.warn on the one that failed.
  persistError(sqlite, context) {
    return persistProbeWindows(sqlite, "codex", context.target.account, context.ts, [{
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
      error: context.error,
      extra: { home: context.target.home, ...(context.target.identity ? { codex_account: JSON.stringify(context.target.identity) } : {}) },
    }]);
  },
};
export async function probeAccount(
  account: string,
  home: string,
  timeoutMs = 30_000
): Promise<ProbeResult> {
  const outcome = await probeTarget(codexProbeAdapter, { account, home, timeoutMs });
  return {
    account,
    home,
    ts: outcome.ts,
    limits: outcome.meta?.limits ?? [],
    error: outcome.error,
  };
}
export interface ProbeCycleResult {
  ts: string;
  probed: number;
  rows: number;
  errors: Array<{ account: string; error: string }>;
}
export function codexAuthPath(home: string): string {
  return path.join(home, "auth.json");
}
/** Which OpenAI account is logged into this CODEX_HOME, from the id_token payload. */
export function readCodexIdentity(home: string): IdentityRead {
  const { identity, error } = readCodexAccountIdentity(home);
  return { identity: identity ? { identity_kind: identity.email ? "email" : "profile",
    identity: identity.email ?? identity.account_id!, raw_source: codexAuthPath(home) } : null, error };
}
/** Discover only profiles whose local identity matches the declared account. */
export function discoverCodexHome(
  account: string | undefined,
  candidates = [process.env.CODEX_HOME, path.join(os.homedir(), ".codex")]
): string | null {
  const expected = account?.trim().toLowerCase();
  if (!expected) return null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const home = path.resolve(candidate);
    const key = process.platform === "win32" ? home.toLowerCase() : home;
    if (seen.has(key)) continue;
    seen.add(key);
    const { identity } = readCodexIdentity(home);
    if (identity?.identity.trim().toLowerCase() === expected) return home;
  }
  return null;
}
export async function runProbeCycle(
  sqlite: Database,
  targets: ProbeTarget[],
  options?: ProbeCycleOptions
): Promise<ProbeCycleResult> {
  const cycle = await runCoreProbeCycle(sqlite, codexProbeAdapter, targets, options);
  return {
    ts: cycle.ts,
    probed: cycle.probed,
    rows: cycle.rows,
    errors: cycle.errors,
  };
}
