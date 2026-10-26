import { acceptProbeFact, backfillProbeFacts, createProbeCollection, hasProbeFacts, mapProbeLegacy } from "../../db/probe-facts";
import type { Database } from "bun:sqlite";
import { LOGIN, MACHINE } from "../../config/paths";
import { PROBE_JOURNAL_FILE, enqueueGaugeJournal, type ProbeJournalRow } from "./journal";
import {
  ProviderProbeError,
  type ProbeCycleOptions,
  type ProbeCycleResult,
  type ProbeHttpResponse,
  type ProbeOutcome,
  type ProviderId,
  type ProviderProbeAdapter,
  type WindowReading,
} from "../types";
const projectionFields = ["provider", "subject", "ts", "plan", "kind", "limit_group", "scope", "reported_percent_side",
  "used_percent", "remaining_percent", "vendor_percent", "window_minutes", "allowance", "used", "remaining",
  "resets_at", "rate_limit_reached", "reset_credits", "profile", "ok", "error", "extra", "machine"] as const;
export function persistProbeWindows(
  sqlite: Database,
  provider: ProviderId,
  subject: string,
  ts: string,
  readings: WindowReading[]
): number {
  backfillProbeFacts(sqlite);
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO probe_windows (${projectionFields.join(",")})
    VALUES (${projectionFields.map(() => "?").join(",")}) RETURNING id`);
  const update = sqlite.prepare(`UPDATE probe_windows SET ${projectionFields.map(field => `${field}=?`).join(",")}
    WHERE id=? RETURNING id`);
  // These are the provider-specific sample identities in the migrated schema; NULLs do not collide.
  const identityFields = provider === "claude" ? ["provider", "subject", "kind", "limit_group", "scope", "ts"] as const
    : provider === "codex" || provider === "gemini" ? ["provider", "subject", "limit_group", "kind", "ts"] as const
    : provider === "glm" ? ["provider", "subject", "kind", "ts"] as const : null;
  return sqlite.transaction(() => {
    const journal: ProbeJournalRow[] = [];
    for (const reading of readings) {
      const row: ProbeJournalRow = {
        provider,
        subject,
        ts,
        plan: reading.plan,
        kind: reading.kind,
        limit_group: reading.group,
        scope: reading.scope,
        reported_percent_side: reading.reportedPercentSide,
        used_percent: reading.usedPercent,
        remaining_percent: reading.remainingPercent,
        vendor_percent: reading.vendorPercent,
        window_minutes: reading.windowMinutes,
        allowance: reading.allowance,
        used: reading.used,
        remaining: reading.remaining,
        resets_at: reading.resetsAt,
        rate_limit_reached: reading.rateLimitReached == null ? null : reading.rateLimitReached ? 1 : 0,
        reset_credits: reading.resetCredits,
        profile: reading.profile,
        ok: reading.ok == null ? null : reading.ok ? 1 : 0,
        error: reading.error,
        extra: reading.extra == null ? null : JSON.stringify(reading.extra),
        machine: MACHINE,
        login: LOGIN,
        source_home: typeof reading.extra?.home === "string" ? reading.extra.home : null,
        raw_subject: subject,
      };
      journal.push(row);
    }
    const facts = hasProbeFacts(sqlite) ? createProbeCollection(journal.map(row => ({ ...row }))) : [];
    for (const [index, row] of journal.entries()) {
      const fact = facts[index];
      if (fact) { acceptProbeFact(sqlite, fact); row.canonical_probe = fact; }
      // REPLACE suppresses its implicit DELETE trigger with SQLite's normal settings,
      // leaving incremental indexes behind. UPDATE journals both projection versions.
      const values = projectionFields.map(field => row[field] ?? null);
      let written = insert.get(...values) as { id: number } | null;
      if (!written && identityFields) {
        const existing = sqlite.query(`SELECT id FROM probe_windows WHERE ${identityFields.map(field => `${field}=?`).join(" AND ")}`)
          .get(...identityFields.map(field => row[field] ?? null)) as { id: number } | null;
        // An explicit UPDATE also works with the older current-model triggers: the outer
        // UPSERT conflict policy would otherwise override their INSERT OR IGNORE statements.
        if (existing) written = update.get(...values, existing.id) as { id: number } | null;
      }
      if (!written) throw new Error("Probe projection did not return its row id");
      if (fact) mapProbeLegacy(sqlite, fact, written.id, "local-collection");
    }
    enqueueGaugeJournal(sqlite, PROBE_JOURNAL_FILE, journal);
    return readings.length;
  }).immediate();
}
export function normalizeProbeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function fetchProbeJson<TBody>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<ProbeHttpResponse<TBody>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = response.ok ? ((await response.json()) as TBody) : null;
    return { ok: response.ok, status: response.status, body, retryAfter: response.headers.get("retry-after") };
  } catch (error) {
    const message = normalizeProbeError(error);
    if (controller.signal.aborted || /abort|timeout/i.test(message)) {
      throw new ProviderProbeError(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function probeTarget<
  TTarget,
  TCredentials,
  TRaw,
  TReading extends WindowReading,
  TMeta,
  TSample,
>(
  adapter: ProviderProbeAdapter<TTarget, TCredentials, TRaw, TReading, TMeta, TSample>,
  target: TTarget
): Promise<ProbeOutcome<TTarget, TReading, TMeta> & { credentials: TCredentials | null }> {
  const ts = new Date().toISOString();
  const credentialResult = adapter.credentials(target);
  if (!credentialResult.creds) {
    return {
      target,
      ts,
      readings: [],
      meta: null,
      rows: 0,
      error: credentialResult.error ?? "brak poĹ›wiadczeĹ„",
      credentials: null,
    };
  }
  try {
    const raw = await adapter.request(target, {
      credentials: credentialResult.creds,
      fetchJson: fetchProbeJson,
    });
    const parsed = adapter.parse(raw);
    const validationError = adapter.validate?.(parsed) ?? null;
    return {
      target,
      ts,
      readings: parsed.readings,
      meta: parsed.meta,
      rows: 0,
      error: validationError,
      credentials: credentialResult.creds,
    };
  } catch (error) {
    return {
      target,
      ts,
      readings: [],
      meta: null,
      rows: 0,
      error: normalizeProbeError(error),
      credentials: credentialResult.creds,
    };
  }
}
async function runTarget<
  TTarget,
  TCredentials,
  TRaw,
  TReading extends WindowReading,
  TMeta,
  TSample,
>(
  sqlite: Database,
  adapter: ProviderProbeAdapter<TTarget, TCredentials, TRaw, TReading, TMeta, TSample>,
  target: TTarget
): Promise<ProbeOutcome<TTarget, TReading, TMeta>> {
  const outcome = await probeTarget(adapter, target);
  if (outcome.error || !outcome.credentials || outcome.meta == null) {
    outcome.rows = adapter.persistError?.(sqlite, {
      target,
      ts: outcome.ts,
      error: outcome.error ?? "nieznany bĹ‚Ä…d probe",
    }) ?? 0;
    return outcome;
  }
  outcome.rows = adapter.persist(sqlite, outcome.readings, {
    target,
    credentials: outcome.credentials,
    ts: outcome.ts,
    meta: outcome.meta,
  });
  return outcome;
}
export async function runProbeCycle<
  TTarget,
  TCredentials,
  TRaw,
  TReading extends WindowReading,
  TMeta,
  TSample,
>(
  sqlite: Database,
  adapter: ProviderProbeAdapter<TTarget, TCredentials, TRaw, TReading, TMeta, TSample>,
  targets: TTarget[],
  options: ProbeCycleOptions = {}
): Promise<ProbeCycleResult<TTarget, TReading, TMeta>> {
  const cycle: ProbeCycleResult<TTarget, TReading, TMeta> = {
    ts: new Date().toISOString(),
    probed: 0,
    rows: 0,
    errors: [],
    outcomes: [],
  };
  if (adapter.capabilities.targetConcurrency === "parallel") {
    cycle.outcomes = await Promise.all(targets.map((target) => runTarget(sqlite, adapter, target)));
  } else {
    for (const target of targets) cycle.outcomes.push(await runTarget(sqlite, adapter, target));
  }
  cycle.probed = cycle.outcomes.length;
  for (const outcome of cycle.outcomes) {
    cycle.rows += outcome.rows;
    if (outcome.error) {
      const error = { account: adapter.subject(outcome.target), error: outcome.error };
      cycle.errors.push(error);
      options.onError?.(error);
    }
  }
  return cycle;
}
