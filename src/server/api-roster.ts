import { isCodexWindowMinutes } from "../shared/codex-counters";
import { codexProbeAdapter } from "../providers/adapters/codex";
import { claudeProbeAdapter } from "../providers/adapters/claude";
import { geminiProbeAdapter, loadPool, latestGeminiState, fingerprintCollisions } from "../providers/adapters/gemini";
import { glmProbeAdapter } from "../providers/adapters/glm";
import type { UnpricedModel } from "../shared/missing-rate";
import { accountUsageSpan } from "./account-usage-span";
import { readWindowIntervals, WindowUsagePreparing, readSpanSums, readWindowSums } from "./window-usage-read";
import { unpricedModels } from "./window-usage-presentation";
import { grokRollingId } from "./grok-gauge-spans";
import type { AppContext } from "./app-context-types";
import { accountResolverOf, distinctSubscriptions, planLabel } from "./account-scope";
import { round2 } from "./api-report-values";
import type { GeminiAccountState } from "../providers/adapters/gemini";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { preparingRows } from "./preparing-response";
import type { CreditPoolsOfRange } from "../shared/credit-pools";
import type { ProbeLimitWindow } from "./probe-limit-windows";
import { claudeWeeklyRegisterWindows } from "./probe-limit-windows";
import { LimitWindowsPreparing } from "../db/limit-windows";
import { windowCreditPools } from "./api-window-rail";
import type { RosterPreparingAccount } from "./roster-fallback";
import { readCardHistories, cardSubscriptionActivity, cardProbeHealth } from "./probe-health";
import type { UsageCycleOut } from "./codex-cycle-series";
import type { CreditWindowBasis } from "../shared/credit-funded";
import { readCodexLimitWindows, codexLimitCounter } from "./codex-limit-windows";
import { codexCycles } from "./codex-cycle-series";
import { creditBasisOf, currentPointBasis } from "../shared/current-point-basis";
import type { ClaudeGaugeConfig, ClaudeLimitReport } from "./claude-limit";
import { claudeAccountId, buildClaudeLimitCard } from "./claude-limit";
import { readClaudeRosterMeters } from "./roster-meters";
import { currentStoredBody } from "./data-read";
import { getClaudeRate } from "./pricing";
import { buildGrokLimit } from "./grok-limit";
import { buildGlmLimit } from "./glm-limit";
import { planActivityAt } from "./account-periods";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { declaredVendorAccount } from "./eras";
import { probeWindowColumns, hasQualifyingProbeWindow } from "./account-probe-availability";
import { storedCycles, EMPTY_SUBSCRIPTION_ACTIVITY } from "./api-era-timelines";
import { latestAccountState, selectCodexPlanState } from "./account-probes";
import { PLAN_LIMIT_ID_SERIES } from "./api-usage-series";
import { grokAccounts, storedGrokWindow, grokGaugeFor } from "./grok-roster-read";
import { observedVendorAccounts } from "./account-identity";
import type { AccountStateRow } from "./account-probes";

interface AccountCapabilities {
  hasGaugeSeries: boolean | null;
  hasTokenDetail: boolean | null;
  hasCalibration: boolean | null;
  hasSecondWindow: boolean | null;
  reportsSide: "used" | "remaining" | null;
  unit: "token" | "credit" | "tick" | null;
}

type KnownRosterProvider = "codex" | "claude" | "gemini" | "glm" | "grok";

const PROBE_CAPABILITIES = {
  codex: codexProbeAdapter.capabilities,
  claude: claudeProbeAdapter.capabilities,
  gemini: geminiProbeAdapter.capabilities,
  glm: glmProbeAdapter.capabilities,
} as const;

const SERVER_CAPABILITIES: Record<
  KnownRosterProvider,
  Omit<AccountCapabilities, "reportsSide">
> = {
  codex: {
    hasGaugeSeries: true,
    hasTokenDetail: true,
    hasCalibration: false,
    hasSecondWindow: null,
    unit: "token",
  },
  claude: {
    hasGaugeSeries: false,
    hasTokenDetail: true,
    hasCalibration: true,
    hasSecondWindow: true,
    unit: "token",
  },
  gemini: {
    hasGaugeSeries: false,
    hasTokenDetail: false,
    hasCalibration: false,
    hasSecondWindow: true,
    unit: "token",
  },
  glm: {
    hasGaugeSeries: false,
    hasTokenDetail: true,
    hasCalibration: false,
    hasSecondWindow: true,
    unit: glmProbeAdapter.capabilities.unit === "credits" ? "credit" : null,
  },
  grok: {
    hasGaugeSeries: false,
    hasTokenDetail: true,
    hasCalibration: true,
    hasSecondWindow: false,
    unit: "tick",
  },
};

const UNKNOWN_ACCOUNT_CAPABILITIES: AccountCapabilities = {
  hasGaugeSeries: null,
  hasTokenDetail: null,
  hasCalibration: null,
  hasSecondWindow: null,
  reportsSide: null,
  unit: null,
};

function accountCapabilities(provider: string | null): AccountCapabilities {
  const normalized = provider === "anthropic" ? "claude" : provider;
  if (normalized == null || !(normalized in SERVER_CAPABILITIES)) {
    return UNKNOWN_ACCOUNT_CAPABILITIES;
  }
  const id = normalized as KnownRosterProvider;
  const probe = id === "grok" ? null : PROBE_CAPABILITIES[id];
  const reportsSide =
    probe?.reportsPercent === "used" || probe?.reportsPercent === "remaining"
      ? probe.reportsPercent
      : null;
  return { ...SERVER_CAPABILITIES[id], reportsSide };
}

interface GeminiModelRow {
  model: string;
  generations: number;
  tokens: number;
  fresh: number;
  usd: number;
}

interface GeminiSpend {
  anchored: boolean;
  since_ts: string;
  until_ts: string;
  resolution: "conversation";
  generations: number;
  conversations: number;
  gross: number;
  fresh_in: number;
  cached_in: number;
  out_total: number;
  out_thinking: number;
  usd: number;
  usd_basis: "api-eq";
  models: GeminiModelRow[];
  first_ts: string | null;
  last_ts: string | null;
  all_time_gross: number;
  all_time_usd: number;
  /** Counted tokens without an API price, per model; present only when some exist. */
  unpriced_models?: UnpricedModel[];
}

/**
 * The Gemini card's traffic (plan U1.4) from stored rows: with a weekly reset from the newest quota
 * reading, the producer's span of that week; otherwise its rolling span of `windowMinutes` up to the
 * account's newest call. Both hold every call by its recorded conversation time (`resolution`). The
 * account's whole traffic comes from the usage ledger's stored days. No call is read here; null when
 * the account owns no call, a missing row is "preparing".
 */
function storedGeminiSpend(ctx: AppContext, account: string, weeklyReset: string | null, windowMinutes: number): GeminiSpend | null {
  const total = accountUsageSpan(ctx.sqlite, "gemini", account, accountResolverOf(ctx), ctx.rateCards);
  if (!total) return null;
  const intervals = readWindowIntervals(ctx.sqlite, "gemini", account);
  const anchoredStart = weeklyReset && windowMinutes === 10080 ? new Date(Date.parse(weeklyReset) - 10080 * 60_000).toISOString() : null;
  const span = anchoredStart
    ? intervals.find((interval) => interval.kind === "anchored" && interval.start === anchoredStart)
    : intervals.find((interval) => interval.kind === "rolling" && interval.id === grokRollingId(windowMinutes));
  if (!span) {
    // A length the producer does not keep has no stored span; one it keeps is still being prepared.
    if (!anchoredStart && intervals.some((interval) => interval.kind === "rolling")) return null;
    throw new WindowUsagePreparing();
  }
  const rail = readSpanSums(ctx.sqlite, "gemini", account, [span.id], ["rail"]).get(span.id)!.rail;
  const nowMs = Date.now();
  const out: GeminiSpend = {
    anchored: anchoredStart !== null,
    since_ts: span.start,
    until_ts: anchoredStart ? new Date(Math.min(nowMs, Date.parse(span.end))).toISOString() : span.end,
    resolution: "conversation",
    generations: 0,
    conversations: rail.sessions ?? 0,
    gross: 0, fresh_in: 0, cached_in: 0, out_total: 0, out_thinking: 0,
    usd: round2(rail.api_standard),
    usd_basis: "api-eq",
    models: [],
    first_ts: total.first_ts,
    last_ts: total.last_ts,
    all_time_gross: total.tokens,
    all_time_usd: round2(total.api_standard),
  };
  for (const row of rail.by_model) {
    if (row.excluded !== null) continue;
    const fresh = row.input - row.cached;
    out.generations += row.calls; out.gross += row.input + row.output; out.fresh_in += fresh; out.cached_in += row.cached;
    out.out_total += row.output; out.out_thinking += row.reasoning;
    out.models.push({ model: row.model || "?", generations: row.calls, tokens: row.input + row.output, fresh: fresh + row.output,
      usd: round2(row.api_standard) });
  }
  out.models.sort((a, b) => b.tokens - a.tokens);
  const unpriced = unpricedModels(rail.by_model);
  return unpriced.length ? { ...out, unpriced_models: unpriced } : out;
}

function geminiRosterEntry(
  acc: { id: string; google?: string; port: number | null },
  state: GeminiAccountState | undefined,
  collisions: Record<string, string[]>,
  spend: GeminiSpend | null
) {
  const gemini = state
    ? {
        profile: state.profile,
        ts: state.ts,
        age_minutes: Math.round(state.age_minutes * 10) / 10,
        ok: state.ok,
        error: state.error,
        windows: state.windows,
        fingerprint: state.fingerprint,
        fingerprint_shared_with: state.fingerprint
          ? (collisions[state.fingerprint] ?? []).filter((id) => id !== acc.id)
          : [],
        google: acc.google ?? null,
        port: acc.port,
        spend,
      }
    : null;
  return {
    id: acc.id,
    vendor: "gemini",
    plan: "antigravity",
    label: `${acc.id} (antigravity)`,
    has_gauge: true,
    basis: "quota",
    live: null,
    live_other: [],
    note: spend
      ? "Tokeny odtworzone z protobufu magazynu Antigravity; koszt to API-eq z rate-cards, bo ten vendor nie podaje własnej ceny."
      : "Profil Windows tego konta jest nieczytelny z tej maszyny — jest gauge, nie ma tokenów.",
    gauge_age_hours: state ? Math.round((state.age_minutes / 60) * 100) / 100 : null,
    empty_reason: state
      ? (state.ok ? null : state.error)
      : acc.port == null
        ? "brak odczytu /quota — pula Gemini nie jest dostępna na tej maszynie"
        : "brak odczytu /quota — poller jeszcze nie przemiótł puli",
    cycles: [],
    shadow: null,
    claude: null,
    gemini,
    grok: null,
    glm: null,
  };
}

export function mergeRosterAccounts(accounts: unknown[]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const account of accounts) {
    if (account == null || typeof account !== "object" || Array.isArray(account)) continue;
    const row = account as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    const key = row.id.toLowerCase();
    const previous = byId.get(key);
    byId.set(key, previous ? { ...previous, ...row, id: previous.id } : row);
  }
  return [...byId.values()];
}

/**
 * Account cards (plan U1.3/U1.4): stored rows read on request, no report preparation; the server builds them
 * in a worker (`direct-read.ts`). The response is kept per data stamp and minute like the other
 * clock-dependent routes (`CLOCK_CACHEABLE_ROUTES`).
 */
export async function handleRoster(ctx: AppContext, url: URL): Promise<Response> {
  try { return readRoster(ctx, url); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable || error instanceof WindowUsagePreparing) return preparingRows();
    throw error;
  }
}

const withCreditPools = (pools: CreditPoolsOfRange | null) => pools ? { credit_pools: pools } : {};

/**
 * The pools of a Claude account's current weekly window, as its `/api/windows` row carries them: stored
 * windows and one owned index range over this window and the one before it.
 */
function claudeCurrentCreditPools(ctx: AppContext, account: string, nowMs: number): CreditPoolsOfRange | null {
  let windows: ProbeLimitWindow[];
  try { windows = claudeWeeklyRegisterWindows(ctx.sqlite, account); }
  catch (error) {
    if (!(error instanceof LimitWindowsPreparing)) console.warn("[roster] Claude windows unreadable:", error instanceof Error ? error.message : error);
    return null;
  }
  let index = -1;
  windows.forEach((window, at) => { if (Date.parse(window.start) <= nowMs && nowMs < Date.parse(window.end)) index = at; });
  if (index < 0) return null;
  try { return windowCreditPools(ctx, "claude", account, windows.slice(Math.max(0, index - 1), index + 1)).get(windows[index]!.id) ?? null; }
  catch (error) {
    if (!(error instanceof ProbeAccountIndexUnavailable || error instanceof WindowUsagePreparing)) throw error;
    return null;
  }
}

function readRoster(ctx: AppContext, url: URL): Response {
  const windowParam = url.searchParams.get("window") || "10080";
  const windowMinutes = parseInt(windowParam, 10);
  if (isNaN(windowMinutes) || windowMinutes <= 0) {
    return Response.json({ error: `Invalid 'window' parameter: '${windowParam}'` }, { status: 400 });
  }
  const nowMs = Date.now();
  const accounts: unknown[] = [];
  // Accounts whose stored rows are still being prepared: each degrades alone instead of the whole roster
  // answering "preparing"; the server fills them from its last ready roster (roster-fallback.ts).
  const preparing: RosterPreparingAccount[] = [];
  const preparingOf = (vendor: string, id: string | null) => (error: unknown) => {
    if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
    preparing.push({ vendor, id });
  };
  const probeColumns = probeWindowColumns(ctx.sqlite);
  // Span, resets and probe health of every account come from the current cards (stored, folded in the background).
  const cards = readCardHistories(ctx.sqlite);
  const activity = cardSubscriptionActivity(cards, storedCycles(ctx.sqlite));
  const stateRows = latestAccountState(ctx);
  const codexSubscriptions = distinctSubscriptions(ctx).filter(
    (entry) => (entry.vendor || "codex") === "codex"
  );
  // The gauge/cycle card is Codex-only: the last eleven stored windows of the account's counter.
  for (const sub of codexSubscriptions) {
    const { live, other: liveOther } = selectCodexPlanState(stateRows, sub.id, windowMinutes);
    const accountWindowMinutes = live?.window_minutes ?? windowMinutes;
    let series: { cycles?: UsageCycleOut[]; latest_ts?: string; first_ts?: string; last_ts?: string; raw_cycle_count?: number; note?: string;
      credit_basis?: CreditWindowBasis | null } = {};
    let seriesPreparing = false;
    try {
      if (!isCodexWindowMinutes(accountWindowMinutes)) series = { note: `no stored windows for window=${accountWindowMinutes}` };
      else {
        const register = readCodexLimitWindows(ctx.sqlite, sub.id, accountWindowMinutes);
        // One window before the tail gives the first card its change against the previous cycle.
        const tail = register.slice(-12);
        const sums = readWindowSums(ctx.sqlite, "codex", sub.id, codexLimitCounter(accountWindowMinutes), tail, ["cycle", "rail", "readings"]);
        // The card shows the newest window's pools; the window before it is read only to measure its first change.
        const newest = tail.at(-1), pools = windowCreditPools(ctx, "codex", sub.id, tail.slice(-2));
        const newestPools = newest && pools.has(newest.id) ? new Map([[newest.id, pools.get(newest.id)!]]) : undefined;
        const cycles = codexCycles(tail, sums, nowMs, [], newestPools).slice(register.length > 11 ? 1 : 0);
        const readings = register.flatMap(window => window.readings.map(reading => reading.ts)).sort();
        const creditBasis = newestPools ? creditBasisOf(currentPointBasis(cycles)) : null;
        series = readings.length ? { cycles, first_ts: readings[0], last_ts: readings.at(-1), latest_ts: readings.at(-1), raw_cycle_count: register.length,
          credit_basis: creditBasis }
          : { note: `no samples for window=${accountWindowMinutes} limit_id=${PLAN_LIMIT_ID_SERIES} in the selected range` };
      }
    } catch (error) {
      preparingOf("codex", sub.id)(error);
      series = {};
      seriesPreparing = true;
    }
    const cycles = series.cycles || [];
    if (series.first_ts && series.last_ts && series.raw_cycle_count != null) {
      activity.set(sub.id.toLowerCase(), {
        first_seen: series.first_ts,
        last_seen: series.last_ts,
        cycle_count: series.raw_cycle_count,
      });
    }
    const latestTs = series.latest_ts || null;
    const gaugeAgeHours = latestTs ? (nowMs - new Date(latestTs).getTime()) / 3_600_000 : null;
    accounts.push({
      live,
      live_other: liveOther,
      id: sub.id,
      vendor: sub.vendor || "codex",
      plan: null,
      label: planLabel(sub, ctx),
      has_gauge: cycles.length > 0,
      basis: "gauge",
      note: sub.note || null,
      gauge_age_hours: gaugeAgeHours == null ? null : Math.round(gaugeAgeHours * 100) / 100,
      empty_reason: seriesPreparing ? null : cycles.length === 0 ? series.note || "brak próbek gauge w indeksie" : null,
      ...(seriesPreparing ? { preparing: true } : {}),
      cycles,
      // The conversion window of the card's credit balance; only an account with credit pools needs it.
      ...(series.credit_basis ? { credit_basis: series.credit_basis } : {}),
      // Stored windows have no parallel shadow chain: one register per account and counter.
      shadow: null,
      claude: null,
      gemini: null,
      grok: null,
      glm: null,
    });
  }
  const claudeConfigs = new Map<string, ClaudeGaugeConfig>();
  const configuredClaudeAccount = claudeAccountId(ctx.claudeGauge?.subscription);
  if (configuredClaudeAccount) claudeConfigs.set(configuredClaudeAccount.toLowerCase(), ctx.claudeGauge);
  for (const a of ctx.vendorDiscovery?.accounts ?? []) if (a.vendor === "claude" && claudeAccountId(a.id) && !claudeConfigs.has(a.id.toLowerCase())) {
    claudeConfigs.set(a.id.toLowerCase(),{vendor:"claude",subscription:a.id,plan:a.plan ?? "unknown",window_hours:168,session_hours:5,observations:[]});
  }
  for (const cfg of claudeConfigs.values()) if (cfg.plan) {
    const account = claudeAccountId(cfg.subscription)!;
    let meters: ReturnType<typeof readClaudeRosterMeters> | undefined;
    try { meters = readClaudeRosterMeters(ctx.sqlite, account, nowMs); }
    catch (error) { if (!(error instanceof LimitWindowsPreparing)) throw error; }
    try {
      // The account's stored live Claude limit (window-screens.ts, the same report and configuration) while it is current;
      // building it here read every reading of the account on each roster miss.
      const stored = currentStoredBody(ctx, new URL(`/api/claude-limit-card?account=${encodeURIComponent(account)}`, "http://local")) as ClaudeLimitReport | null;
      const report = stored ?? buildClaudeLimitCard(
        ctx.sqlite,
        cfg,
        (model, day, speed) => getClaudeRate(ctx.rateCards, model, day, speed),
        undefined,
        { rateCards: ctx.rateCards, eras: ctx.eras, resolver: accountResolverOf(ctx), cycles: ctx.cycles }
      );
      accounts.push({
        id: account,
        vendor: cfg.vendor || "claude",
        plan: report.plan,
        label: `${account} (${report.plan ?? "?"})`,
        has_gauge: hasQualifyingProbeWindow(
          ctx.sqlite,
          "claude",
          account,
          probeColumns
        ),
        basis: "declared",
        note: "pułap z claude-gauge.json, zużycie zmierzone z indeksu",
        gauge_age_hours: null,
        empty_reason: report.current ? null : "brak odczytu tygodniowego w claude-gauge.json",
        cycles: [],
        shadow: null,
        claude_meters: meters,
        claude: {
          window_hours: report.window_hours,
          current: report.current,
          session: report.session,
          confidence: report.calibration?.confidence || "none",
          calibration_reason: report.calibration?.reason || null,
          usd_per_point: report.calibration?.usd_per_point ?? null,
          window_value_usd: report.calibration?.window_value_usd ?? null,
          caveat_count: report.caveats.length,
          ...withCreditPools(claudeCurrentCreditPools(ctx, account, nowMs)),
        },
        gemini: null,
        grok: null,
        glm: null,
      });
    } catch (error) {
      const account = claudeAccountId(cfg.subscription)!;
      preparingOf("claude", account)(error);
      accounts.push({ ...preparingRosterEntry("claude", account, "declared", cfg.plan, `${account} (${cfg.plan})`), claude_meters: meters });
    }
  }
  // Gemini cards come from the declarations; the pool file is only where the
  // probe finds workers, and it exists on one machine.
  const geminiDeclared = distinctSubscriptions(ctx).filter((entry) => entry.vendor === "gemini");
  if (geminiDeclared.length > 0) {
    const poolById = new Map(loadPool().map((acc) => [acc.id.toLowerCase(), acc]));
    const states = latestGeminiState(ctx.sqlite);
    const byId = new Map(states.map((st) => [st.account.toLowerCase(), st]));
    const collisions = fingerprintCollisions(
      states.map((st) => ({
        account: st.account,
        profile: st.profile ?? "",
        ts: st.ts,
        rows: [],
        fingerprint: st.fingerprint,
        error: st.error,
      }))
    );
    for (const declared of geminiDeclared) try {
      const detected = ctx.vendorDiscovery?.accounts.find(a=>a.id === declared.id);
      const worker = detected?.profiles.find(p=>p.worker)?.worker ?? poolById.get(declared.id.toLowerCase());
      const acc = { id: declared.id, google: worker?.google, port: worker?.port ?? null };
      const st = byId.get(acc.id.toLowerCase());
      const weekly = st?.windows.find((w) => /^gemini/i.test(w.limit_group) && w.kind === "weekly");
      const reset = weekly?.resets_at && Number.isFinite(Date.parse(weekly.resets_at)) ? weekly.resets_at : null;
      const spend = storedGeminiSpend(ctx, acc.id, reset, windowMinutes);
      const entry = geminiRosterEntry(acc, st, collisions, spend);
      accounts.push({...entry, has_gauge:!!st?.ok && st.windows.length > 0,
        plan:detected?.profiles[0]?.surface === "gemini-cli" ? "Gemini CLI" : entry.plan,
        empty_reason:entry.empty_reason ?? null,
        note:detected?.profiles[0]?.error ?? entry.note});
    } catch (error) {
      preparingOf("gemini", declared.id)(error);
      accounts.push(preparingRosterEntry("gemini", declared.id, "quota", null, declared.id));
    }
  }
  for (const store of grokAccounts(ctx)) try {
    const win = storedGrokWindow(ctx, store, windowMinutes);
    const limit = buildGrokLimit(ctx.sqlite, grokGaugeFor(ctx, store));
    const measured = limit?.current?.percent_measured != null;
    accounts.push({
      id: store,
      vendor: "grok",
      plan: limit?.plan || ctx.grokGauge?.plan || "xai",
      label: `${store} (${limit?.plan || ctx.grokGauge?.plan || "xai"})`,
      has_gauge:
        hasQualifyingProbeWindow(ctx.sqlite, "grok", store, probeColumns) ||
        (limit?.observations.length ?? 0) > 0,
      basis: measured ? "gauge" : "spend",
      live: null,
      live_other: [],
      note: measured
        ? "Procent i reset są odczytane z Billing Groka; tokeny i koszt pochodzą z lokalnych sesji."
        : limit?.calibration
          ? "Brak aktywnego odczytu Billing — procent awaryjnie wyliczony z deklarowanej skali."
          : "Brak aktywnego odczytu Billing i brak kalibracji procentu.",
      gauge_age_hours:
        limit?.current?.measurement_age_minutes == null ? null : limit.current.measurement_age_minutes / 60,
      empty_reason: measured || (win && win.spend.turns > 0) ? null : "brak tur i odczytu Billing w tym oknie",
      cycles: [],
      shadow: null,
      claude: null,
      gemini: null,
      grok: win ? { ...win, limit } : null,
      glm: null,
    });
  } catch (error) {
    preparingOf("grok", store)(error);
    accounts.push(preparingRosterEntry("grok", store, "spend", ctx.grokGauge?.plan || "xai", `${store} (${ctx.grokGauge?.plan || "xai"})`));
  }
  let glmReport: ReturnType<typeof buildGlmLimit> = null;
  // Its subscription id comes from the report itself: a preparing GLM card is filled by vendor.
  try { glmReport = buildGlmLimit(ctx.sqlite); }
  catch (error) { preparingOf("glm", null)(error); }
  if (glmReport) {
    const head = glmReport.windows.find((w) => w.kind === glmReport.headline_kind) ?? glmReport.windows[0]!;
    accounts.push({
      id: glmReport.subscription,
      vendor: "glm",
      plan: glmReport.level,
      label: `glm (${glmReport.level ?? "coding plan"})`,
      has_gauge: hasQualifyingProbeWindow(ctx.sqlite, "glm", glmReport.subscription, probeColumns),
      basis: "quota",
      live: null,
      live_other: [],
      note:
        "Procent i przydzial sa ODCZYTANE z konta (GET /api/monitor/usage/quota/limit) - obie strony ulamka, w kredytach. " +
        "Tokeny obok pochodza z bazy opencode i sa osobna miara tej samej pracy; dolary sa API-eq, bo plan nie zwraca zadnej ceny.",
      gauge_age_hours: head.measured_age_minutes / 60,
      empty_reason: null,
      cycles: [],
      shadow: null,
      claude: null,
      gemini: null,
      grok: null,
      glm: glmReport,
    });
  }
  const observedAccounts = observedVendorAccounts(ctx);
  const declaredSubs = ctx.accounts.subscriptions || [];
  const nowIso = new Date(nowMs).toISOString();
  // A subscription whose last plan period has ended is inactive; the table holds a few dozen rows.
  let planActive: (provider: string, subject: string) => boolean | null = () => null;
  try { planActive = planActivityAt(loadPeriods(ctx.sqlite, PLAN_PERIODS), nowIso); }
  catch (error) { console.warn("[roster] plan periods unreadable; activity falls back to eras:", error instanceof Error ? error.message : error); }
  const accountsWithCapabilities = mergeRosterAccounts(accounts).map((account) => {
    if (account == null || typeof account !== "object") return account;
    const provider =
      "vendor" in account && typeof account.vendor === "string" ? account.vendor : null;
    const capabilities = accountCapabilities(provider);
    const id = "id" in account && typeof account.id === "string" ? account.id : "";
    const declaredAccount = declaredVendorAccount(declaredSubs, id, nowIso);
    const observedAccount = observedAccounts.get(id.toLowerCase()) ?? null;
    const discovered = (provider === "codex" ? ctx.codexDiscovery?.accounts : ctx.vendorDiscovery?.accounts)?.find(a => a.id.toLowerCase() === id.toLowerCase());
    const era = {
      active: (provider ? planActive(provider, id) : null) ?? (discovered ? discovered.current : (() => {
        const metadata = declaredSubs.find(s => s.id.toLowerCase() === id.toLowerCase());
        return metadata?.status ? metadata.status === "active" : ctx.eras.entriesOf(id).some(entry => !entry.until);
      })()),
      vendor_account: discovered?.email ?? declaredAccount ?? observedAccount,
      vendor_account_source: discovered?.email ? (ctx.vendorDiscovery?.accounts.find(a=>a.id === id)?.profiles.every(p=>p.surface === "antigravity") ? "declared" : "observed") : declaredAccount ? "declared" : observedAccount ? "observed" : null,
      account_sources: discovered?.profiles.map(p => `${p.machine} / ${p.login}`) ?? [],
      ...(activity.get(id.toLowerCase()) ?? EMPTY_SUBSCRIPTION_ACTIVITY),
      // Cross-machine probe state: newest good sample from any PC plus the
      // per-machine success/error trail behind it.
      probe: provider ? cardProbeHealth(cards, provider, id, nowMs) : null,
    };
    if (provider !== "codex") return { ...account, ...era, capabilities,
      plan: ctx.vendorDiscovery?.accounts.find(a=>a.id === id)?.plan ?? account.plan };
    const row = account as { live?: AccountStateRow | null; live_other?: AccountStateRow[] };
    const planWindows = [row.live ?? null, ...(row.live_other ?? [])]
      .filter((state): state is AccountStateRow => state != null && state.limit_id === "codex")
      .map((state) => state.window_minutes)
      .filter((minutes): minutes is number => minutes != null);
    return {
      ...account,
      ...era,
      plan: row.live?.plan_type ?? account.plan,
      capabilities: {
        ...capabilities,
        hasSecondWindow:
          planWindows.length === 0 ? null : new Set(planWindows).size > 1,
      },
    };
  });
  return Response.json({
    window_minutes: windowMinutes,
    count: accountsWithCapabilities.length,
    accounts: accountsWithCapabilities,
    ...(preparing.length ? { preparing_accounts: preparing } : {}),
  });
}

/** A card whose stored rows are still being prepared: no figures, never presented as an empty window. */
function preparingRosterEntry(vendor: string, id: string, basis: string, plan: string | null, label: string) {
  return { id, vendor, plan, label, has_gauge: false, basis, note: null, gauge_age_hours: null, empty_reason: null,
    live: null, live_other: [], cycles: [], shadow: null, claude: null, gemini: null, grok: null, glm: null, preparing: true };
}
