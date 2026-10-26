import type { RailSample } from "./rail-readings";
import type { RailWindow, RailTrafficShare } from "../web/lib/windows";
import type { ProbeLimitWindow, ProbeLimitEvidence } from "./probe-limit-windows";
import type { WindowEndEstimate } from "./window-end-estimate";
import type { DatedPeriod } from "./account-periods";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { ProbeAccountReadings } from "./current/probe-account-reader";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { loadProbeLimitEvidence, probeLimitCounter, probeWindowPlan, probeLimitEvidenceOf, claudeWeeklyRegisterWindows } from "./probe-limit-windows";
import { resolveCadenceForDay } from "./cycles";
import { railWindowHours, observedCadence as observedProbeCadence } from "./claude-declared-windows";
import { usedPercentOf } from "../providers/adapters/gemini";
import { sameResetWindow, decodeClaudeAccountMeters } from "../providers/adapters/claude";
import { readManualCapacity } from "./manual-capacity";
import { readLimitWindows, LimitWindowsPreparing } from "../db/limit-windows";
import { creditPoolReadings, creditPoolsInRange, CODEX_CREDITS_RECORDED_FROM } from "../shared/credit-pools";
import type { CadenceSource, ObservedCadence } from "./cycles";
import { windowFromReset, limitPace, windowElapsedPercent } from "../providers/core/limit";
import { segmentPace, boostFactorAt, claudeAccountId, buildClaudeLimit } from "./claude-limit";
import type { ClaudeAccountMeters, ClaudeAccountSplitWindow, ClaudeAccountSplitsResponse } from "../shared/claude-code-capacity";
import { MIN_RAIL_SHAPE_POINTS } from "../web/lib/windows";
import { planPeriodIndex, effectiveDatedPeriods } from "./account-periods";
import { parseCapacityCounter } from "../shared/manual-capacity";
import type { AppContext } from "./app-context-types";
import { accountResolverOf, resolveAccountScope } from "./account-scope";
import { HOUR_MS, round2 } from "./api-report-values";
import { buildGrokLimit } from "./grok-limit";
import { grokGaugeFor, grokAccounts } from "./grok-roster-read";
import { readWindowIntervals, readSpanSums, WindowUsagePreparing, readWindowSums } from "./window-usage-read";
import { totalSpend } from "./window-usage-presentation";
import type { ClaudeGaugeConfig } from "./claude-limit";
import { getClaudeRate } from "./pricing";
import { readWindowEndEstimates } from "./window-end-estimate";
import { normEraVendor } from "./eras";
import { archiveFolderOf } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { machineForActivitySource } from "./account-identity";
import { buildClaudeCodeCapacityReport, claudeCodeCapacitySummary, selectClaudeCodeCapacityReport } from "./claude-code-capacity";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { claudeAccountSplit } from "../shared/claude-code-capacity";
import { readClaudeCapacityResult } from "./claude-capacity-result";
import { readPreparedProbeAccountReadings, ProbeAccountIndexUnavailable, selectOwnedProbes, probeReadContext } from "./current/probe-account-reader";
import type { WindowRailSums, WindowCycleSums } from "./window-usage-contracts";
import { preparingRows } from "./preparing-response";
import type { CreditPoolsOfRange } from "../shared/credit-pools";
import { readCardHistories, cardActivity } from "./probe-health";
import { codexVisibleLimitWindows, readCodexLimitWindows, codexLimitCounter } from "./codex-limit-windows";
import { withReadSnapshot } from "../db/analysis";
import { grokGaugeAccount } from "./grok-gauge-spans";
import { probeWindowColumns } from "./account-probe-availability";
import { storedContextPrice } from "../shared/context-price";
import { windowActiveAt } from "../shared/window-activity";

interface ProbeRailSample {
  id: number;
  provider: string;
  subject: string;
  ts: string;
  plan: string | null;
  kind: string;
  limit_group: string | null;
  scope: string | null;
  used_percent: number | null;
  remaining_percent: number | null;
  vendor_percent: number | null;
  window_minutes: number | null;
  allowance: number | null;
  used: number | null;
  remaining: number | null;
  resets_at: string | null;
  machine: string | null;
  ok: number | null;
  extra?: string | null;
  manual?: RailSample["manual"];
  limitHit?: RailSample["limitHit"];
}

type ProbeRailWindow = RailWindow & {
  windowId?: string;
  cycle_end_basis?: ProbeLimitWindow["cycle_end_basis"];
  declared_plan_meter_mismatch?: boolean;
  plan_detail?: ProbeLimitWindow["plan_detail"];
  manual_measurement?: ProbeLimitWindow["manual_measurement"];
  manual_measurements?: ProbeLimitWindow["manual_measurements"];
  /** A closed window whose readings stopped before its end: the stored estimate its percent shows (window-end-estimate.ts). */
  endEstimate?: WindowEndEstimate;
};

type ProbeRailRegister = { evidence: ProbeLimitEvidence; periods: DatedPeriod[];
  measurements: ManualCapacityMeasurement[]; weeklyWindows?: ProbeLimitWindow[]; readings?: ProbeAccountReadings };

function railDurationLabel(hours: number | null): string {
  if (hours == null) return "?";
  if (hours % 168 === 0) return `${hours / 168 * 7}d`;
  if (hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

function railDateLabel(startIso: string | null, resetIso: string | null): string {
  if (!resetIso) return "brak kotwicy resetu";
  if (!startIso) return `→ ${resetIso.slice(0, 10)}`;
  return `${startIso.slice(0, 10)} → ${resetIso.slice(0, 10)}`;
}

function probeRailNote(
  provider: string,
  sample: ProbeRailSample,
  usedPercent: number | null,
  hasResetAnchor: boolean
): string | null {
  const missingReset = hasResetAnchor ? "" : " Vendor nie podał kotwicy resetu w tym odczycie.";
  if (provider === "gemini") {
    return sample.remaining_percent == null
      ? `Google nie podał zapasu dla tej próbki.${missingReset}`
      : `Vendor podał ${sample.remaining_percent}% zapasu; zużycie = ${usedPercent}%.${missingReset}`;
  }
  if (provider === "glm") {
    return sample.allowance == null
      ? `z.ai nie podał przydziału kredytów dla tego okna.${missingReset}`
      : `Kredyty: ${sample.used ?? "?"} z ${sample.allowance}; pozostało ${sample.remaining ?? "?"}.${missingReset}`;
  }
  if (provider === "claude") {
    return `Anthropic podaje procent okna, ale nie tokeny ani koszt odpowiadającego mu ruchu.${missingReset}`;
  }
  return null;
}

function probeCounterKey(provider: string, kind: string, limitGroup: string | null, scope: string | null): string {
  const part = (value: string | null): string => value == null ? "none" : `value(${encodeURIComponent(value)})`;
  return `${provider}:kind=${part(kind)}:group=${part(limitGroup)}:scope=${part(scope)}`;
}

function probeParentKind(kind: string): string {
  return kind === "weekly_scoped" ? "weekly_all" : kind;
}

/**
 * Plans an account had during [startMs, endMs), read from its plan periods. Null when the account
 * has no plan history, so the caller keeps the labels of its readings. An uncovered stretch is an
 * unknown plan, not a plan change, so it adds nothing.
 */
function probeRailWindows(ctx: AppContext, provider: string, account: string, nowMs: number,
  prepared?: ProbeRailRegister): ProbeRailWindow[] {
  let planPeriods = prepared?.periods ?? [];
  if (!prepared) try { planPeriods = loadPeriods(ctx.sqlite, PLAN_PERIODS); }
  catch (error) { console.warn("[windows] plan periods unreadable:", error instanceof Error ? error.message : error); }
  const evidence = prepared?.evidence ?? loadProbeLimitEvidence(ctx.sqlite, provider, account, accountResolverOf(ctx));
  const samples = evidence.samples as ProbeRailSample[];
  const cadenceFor = (kind: string, windowMinutes: number | null, at: string) =>
    resolveCadenceForDay(ctx.cycles, account, kind, at, {
      periodHours: railWindowHours(provider, kind, windowMinutes),
      anchorIso: null,
      source: "probe",
    });
  const cadenceInstantInsideWindow = (resetIso: string | null, sampleIso: string | null): string => {
    const resetMs = resetIso == null ? NaN : Date.parse(resetIso);
    const sampleMs = sampleIso == null ? NaN : Date.parse(sampleIso);
    if (Number.isFinite(sampleMs) && (!Number.isFinite(resetMs) || sampleMs < resetMs)) {
      return new Date(sampleMs).toISOString();
    }
    if (Number.isFinite(resetMs)) return new Date(resetMs - 1).toISOString();
    return sampleIso ?? resetIso ?? "0001-01-01T00:00:00.000Z";
  };
  const hoursFor = (kind: string, windowMinutes: number | null, at: string): number | null =>
    cadenceFor(kind, windowMinutes, at).periodHours ?? railWindowHours(provider, kind, windowMinutes);
  type ProbeRailGroup = {
    kind: string;
    limitGroup: string | null;
    scope: string | null;
    resetIso: string | null;
    unstarted: boolean;
    samples: ProbeRailSample[];
    /** One counter segment of a server window cut by meter drops; null for a whole window. */
    segment?: {
      fromIso: string | null; untilIso: string | null; baseline: number;
      drop: { before: number; after: number } | null; endDrop: { before: number; after: number } | null;
    } | null;
    register?: ProbeLimitWindow;
  };
  const sameLimit = (group: ProbeRailGroup, sample: ProbeRailSample): boolean =>
    group.kind === sample.kind &&
    group.scope === sample.scope &&
    group.limitGroup === sample.limit_group;
  const isUntouchedGemini = (sample: ProbeRailSample): boolean => {
    if (provider !== "gemini" || sample.resets_at == null) return false;
    const hours = hoursFor(
      sample.kind,
      sample.window_minutes,
      cadenceInstantInsideWindow(sample.resets_at, sample.ts)
    );
    const sampleMs = Date.parse(sample.ts);
    const resetMs = Date.parse(sample.resets_at);
    const usedPercent = sample.remaining_percent == null ? sample.used_percent : usedPercentOf(sample.remaining_percent);
    return usedPercent === 0 && hours != null && Number.isFinite(sampleMs) && Number.isFinite(resetMs) &&
      Math.abs(resetMs - sampleMs - hours * HOUR_MS) <= 2 * 60_000;
  };
  const untouchedGemini = samples.filter(isUntouchedGemini);
  const regularSamples = samples.filter((sample) => !isUntouchedGemini(sample));
  const groups: ProbeRailGroup[] = [];
  for (const sample of regularSamples.filter((row) => row.resets_at != null)) {
    const group = [...groups].reverse().find((candidate) => {
      if (!sameLimit(candidate, sample)) return false;
      return sameResetWindow(candidate.resetIso, sample.resets_at);
    });
    if (group) group.samples.push(sample);
    else groups.push({
      kind: sample.kind,
      limitGroup: sample.limit_group,
      scope: sample.scope,
      resetIso: sample.resets_at,
      unstarted: false,
      samples: [sample],
    });
  }
  for (const sample of regularSamples.filter((row) => row.resets_at == null)) {
    const hours = hoursFor(sample.kind, sample.window_minutes, sample.ts);
    const sampleMs = Date.parse(sample.ts);
    const inferredReset = hours != null && Number.isFinite(sampleMs)
      ? new Date(sampleMs + hours * HOUR_MS).toISOString()
      : null;
    const group = inferredReset == null
      ? null
      : groups
          .filter((candidate) =>
            sameLimit(candidate, sample) &&
            sameResetWindow(candidate.resetIso, inferredReset)
          )
          .sort((a, b) =>
            Math.abs(Date.parse(a.resetIso!) - Date.parse(inferredReset)) -
            Math.abs(Date.parse(b.resetIso!) - Date.parse(inferredReset))
          )[0] ?? null;
    if (group) {
      group.samples.push(sample);
      group.samples.sort((a, b) => a.ts.localeCompare(b.ts));
    } else {
      const orphan = groups.find((candidate) =>
        sameLimit(candidate, sample) && candidate.resetIso == null && !candidate.unstarted
      );
      if (orphan) orphan.samples.push(sample);
      else groups.push({
        kind: sample.kind,
        limitGroup: sample.limit_group,
        scope: sample.scope,
        resetIso: null,
        unstarted: false,
        samples: [sample],
      });
    }
  }
  for (const sample of untouchedGemini) {
    const group = groups.find((candidate) => sameLimit(candidate, sample) && candidate.unstarted);
    if (group) group.samples.push(sample);
    else groups.push({
      kind: sample.kind,
      limitGroup: sample.limit_group,
      scope: sample.scope,
      resetIso: null,
      unstarted: true,
      samples: [sample],
    });
  }
  let measurements: ManualCapacityMeasurement[] = prepared?.measurements ?? [];
  try { measurements = (prepared?.measurements ?? ctx.manualCapacity ?? readManualCapacity(provider).measurements)
    .filter(m => m.account === account.toLowerCase()); }
  catch (error) { console.warn("[windows] manual measurements unreadable:", error instanceof Error ? error.message : error); }
  const registerByCounter = new Map<string, ProbeLimitWindow[]>();
  for (const window of prepared?.weeklyWindows ?? []) {
    const group = registerByCounter.get(window.counter) ?? [];
    group.push(window);
    registerByCounter.set(window.counter, group);
  }
  const railGroups = groups.flatMap((group): ProbeRailGroup[] => {
    if (group.resetIso == null || group.unstarted) return [group];
    const counter = probeLimitCounter(group.samples[0]!, account, ctx.cycles);
    let windows = registerByCounter.get(counter);
    if (!windows) {
      windows = readLimitWindows(ctx.sqlite, provider, account, counter);
      registerByCounter.set(counter, windows);
    }
    // The group's samples by instant, in order: a reading finds the first matching sample without a scan.
    const byInstant = new Map<number, ProbeRailSample[]>();
    for (const sample of group.samples) {
      const instant = Date.parse(sample.ts);
      if (!Number.isFinite(instant)) continue;
      const list = byInstant.get(instant);
      if (list) list.push(sample); else byInstant.set(instant, [sample]);
    }
    return windows.filter(window => sameResetWindow(window.reset, group.resetIso)).map(register => {
      const samples = register.readings.map(reading => {
        const original = byInstant.get(Date.parse(reading.ts))?.find(s =>
          s.used_percent === reading.percent && Boolean(s.limitHit) === (reading.source === "limit_hit"));
        const measurement = reading.source === "manual" ? measurements.find(m => m.counter === counter &&
          ((Date.parse(m.start) === Date.parse(reading.ts) && m.start_percent === reading.percent)
            || (Date.parse(m.end) === Date.parse(reading.ts) && m.end_percent === reading.percent))) : undefined;
        return original ?? { ...group.samples[0]!, id: -1, ts: reading.ts, used_percent: reading.percent,
          manual: measurement ? { id: measurement.id, note: measurement.note } : undefined };
      });
      return { ...group, samples, register,
        segment: register.startDrop || register.endDrop ? {
          fromIso: register.startDrop ? register.start : null,
          untilIso: register.endDrop ? register.end : null,
          baseline: register.startDrop?.after ?? 0, drop: register.startDrop, endDrop: register.endDrop,
        } : null };
    });
  });
  // Decoded once: every window measures its pool changes against the account's previous reading.
  const claudePoolReadings = provider === "claude"
    ? creditPoolReadings(provider, samples.filter(sample => sample.kind === "weekly_all" && sample.scope == null)) : [];
  const out: Array<ProbeRailWindow & {
    newestTs: string;
    kind: string;
    limitGroup: string | null;
    scopeKey: string | null;
    unstarted: boolean;
    cadenceSegmentFrom: string | null;
    cadencePeriodSource: CadenceSource;
    cadenceAnchorSource: CadenceSource;
    cadenceSourceWon: CadenceSource;
  }> = [];
  for (const group of railGroups) {
    const grouped = group.samples;
    const newest = grouped[grouped.length - 1];
    if (!newest) continue;
    const resetMs = group.resetIso == null ? NaN : Date.parse(group.resetIso);
    const latestInside = [...grouped].reverse().find((sample) => {
      const sampleMs = Date.parse(sample.ts);
      return Number.isFinite(sampleMs) && (!Number.isFinite(resetMs) || sampleMs < resetMs);
    });
    const cadenceInsideWindow = cadenceFor(
      newest.kind,
      newest.window_minutes,
      cadenceInstantInsideWindow(group.resetIso, latestInside?.ts ?? null)
    );
    const hours = cadenceInsideWindow.periodHours ?? railWindowHours(provider, newest.kind, newest.window_minutes);
    const serverTiming = windowFromReset(group.resetIso, hours, nowMs);
    // A counter segment runs from the reading after a drop (or the window start) to the next drop
    // (or the reset); `windowHours` stays the counter's nominal length for the rail's grouping.
    const segment = group.segment ?? null;
    const segmentStartMs = group.register ? Date.parse(group.register.start) : serverTiming?.windowStartMs ?? null;
    const segmentEndMs = group.register ? Date.parse(group.register.end) : serverTiming?.resetMs ?? null;
    const timing = group.register && serverTiming && segmentStartMs != null && segmentEndMs != null && segmentEndMs > segmentStartMs
      ? windowFromReset(new Date(segmentEndMs).toISOString(), (segmentEndMs - segmentStartMs) / HOUR_MS, nowMs)
      : serverTiming;
    const usedPercent = newest.manual ? newest.used_percent : provider === "gemini"
      ? newest.remaining_percent == null ? null : usedPercentOf(newest.remaining_percent)
      : newest.used_percent;
    const pace = segment && timing ? segmentPace(usedPercent, segment.baseline, timing) : limitPace(usedPercent, timing);
    const shapeSamples = grouped
      .map((sample) => {
        const sampleUsed = provider === "gemini"
          ? sample.remaining_percent == null ? null : usedPercentOf(sample.remaining_percent)
          : sample.used_percent;
        const sampleMs = Date.parse(sample.ts);
        if (segment && timing?.windowStartMs != null) {
          const span = timing.resetMs - timing.windowStartMs;
          return sampleUsed == null || !Number.isFinite(sampleMs)
            ? null
            : { t: round2(Math.max(0, Math.min(100, ((sampleMs - timing.windowStartMs) / span) * 100))), pct: sampleUsed };
        }
        const sampleTiming = Number.isFinite(sampleMs)
          ? windowFromReset(
              sample.resets_at ?? group.resetIso,
              hoursFor(
                sample.kind,
                sample.window_minutes,
                cadenceInstantInsideWindow(sample.resets_at ?? group.resetIso, sample.ts)
              ),
              sampleMs
            )
          : null;
        return sampleUsed == null || sampleTiming?.elapsedPercent == null
          ? null
          : { t: round2(sampleTiming.elapsedPercent), pct: sampleUsed };
      })
      .filter((point): point is { t: number; pct: number } => point != null)
      .sort((a, b) => a.t - b.t);
    const siblingLimitGroups = new Set(
      groups
        .filter((candidate) => candidate.kind === group.kind && candidate.scope === group.scope)
        .map((candidate) => candidate.limitGroup)
    );
    const displayGroup = provider === "gemini" || siblingLimitGroups.size > 1 ? group.limitGroup : null;
    const counterKey = probeCounterKey(provider, newest.kind, group.limitGroup, group.scope);
    const observedPlans = group.register?.plan ? [group.register.plan] : [];
    const regimeInstance = group.resetIso ?? newest.ts;
    const planKey = group.register?.declared_plan_meter_mismatch ? `mixed-plan@${regimeInstance}` : observedPlans.length === 0
      ? `unknown-plan@${regimeInstance}`
      : observedPlans.length === 1
        ? observedPlans[0]!
        : `mixed-plan@${regimeInstance}`;
    const observedAllowances = [...new Set(grouped.map((sample) => sample.allowance).filter((value): value is number => value != null && Number.isFinite(value)))];
    // Raw allowance is meaningful provenance for credit-based GLM limits.
    // Percent-only vendors identify capacity through their plan (and, for
    // Claude, the historical boost factor).
    const allowanceKey = observedAllowances.length === 0
      ? provider === "glm" ? `unknown-allowance@${regimeInstance}` : "vendor-percent"
      : observedAllowances.length === 1
        ? String(observedAllowances[0])
        : `mixed-allowance@${regimeInstance}`;
    const boostKey = provider === "claude"
      ? String(boostFactorAt(ctx.claudeGauge, timing?.windowStart ?? latestInside?.ts ?? newest.ts))
      : "1";
    const regimeKey = [
      counterKey,
      planKey,
      `${hours ?? "unknown"}h`,
      cadenceInsideWindow.segmentFrom ?? "origin",
      `allowance=${allowanceKey}`,
      `boost=${boostKey}`,
      // A segment is part of a window; it never pools with whole windows as a typical run.
      ...(segment ? [`segment@${timing?.windowStart ?? newest.ts}`] : []),
    ].join(":");
    const keySuffix = group.unstarted
      ? "unstarted"
      : segment?.untilIso != null ? `${group.resetIso}:until=${segment.untilIso}` : group.resetIso ?? "missing-reset";
    const segmentNote = segment?.drop
      ? `Licznik spadł z ${segment.drop.before}% do ${segment.drop.after}% bez zmiany resetu (zmiana planu); ` +
        "odcinek liczy się od pierwszego odczytu po spadku. "
      : segment?.untilIso != null
        ? "Odcinek okna zakończony spadkiem licznika bez zmiany resetu (zmiana planu). "
        : "";
    // The account's other meters travel on the reading of its main weekly counter.
    let accountMeters: ClaudeAccountMeters | null = null;
    if (provider === "claude" && newest.kind === "weekly_all" && group.scope == null && newest.extra) {
      try {
        const decoded = decodeClaudeAccountMeters(JSON.parse(newest.extra) as Record<string, unknown>, newest.ts);
        if (decoded.meters.length > 0 || decoded.extra_usage) accountMeters = decoded;
      } catch { /* an unreadable extra only costs the meters, not the window */ }
    }
    // Claude's pools travel on its main weekly reading; that counter's windows show them.
    const creditPools = provider === "claude" && newest.kind === "weekly_all" && group.scope == null && timing?.windowStartMs != null
      ? creditPoolsInRange(claudePoolReadings, timing.windowStartMs, timing.resetMs) : null;
    out.push({
      key: group.register?.id ?? (group.limitGroup
        ? `${newest.kind}:${group.limitGroup}:${keySuffix}`
        : `${newest.kind}:${keySuffix}`),
      ...(group.register ? { windowId: group.register.id, cycle_end_basis: group.register.cycle_end_basis,
        declared_plan_meter_mismatch: group.register.declared_plan_meter_mismatch,
        plan_detail: group.register.plan_detail, manual_measurement: group.register.manual_measurement,
        ...(group.register.activity ? { activity: group.register.activity } : {}),
        manual_measurements: group.register.manual_measurements } : {}),
      counterKey,
      parentCounterKey: provider === "claude" && group.scope
        ? probeCounterKey(provider, probeParentKind(newest.kind), group.limitGroup, null)
        : null,
      label:
        provider === "claude" && group.scope
          ? `${railDurationLabel(hours)} · ${group.scope}`
          : displayGroup
            ? `${railDurationLabel(hours)} · ${displayGroup}`
            : railDurationLabel(hours),
      counterLabel:
        displayGroup
          ? `${railDurationLabel(hours)} · ${displayGroup}`
          : railDurationLabel(hours),
      dateLabel: group.unstarted
        ? "nierozpoczęte"
        : railDateLabel(timing?.windowStart ?? null, timing?.resetAt ?? newest.resets_at),
      source: "probe",
      // A limit refusal is the vendor's own statement of 100%, so it counts as measured.
      percentBasis: usedPercent == null ? null : newest.manual ? ("manual" as const) : ("measured" as const),
      plan: group.register?.plan ?? null,
      isCurrent: group.unstarted || (group.register ? windowActiveAt(group.register, nowMs) : (
        timing != null && timing.windowStartMs != null
          ? timing.windowStartMs <= nowMs && nowMs < timing.resetMs
          : false
      )),
      usedPercent,
      elapsedPercent: group.unstarted || timing?.elapsedPercent == null ? null : round2(timing.elapsedPercent),
      ppAhead: group.unstarted || pace.ppAhead == null ? null : round2(pace.ppAhead),
      windowHours: hours,
      startIso: group.unstarted ? null : timing?.windowStart ?? null,
      resetIso: group.unstarted ? null : timing?.resetAt ?? group.resetIso,
      shape: !group.unstarted && shapeSamples.length >= MIN_RAIL_SHAPE_POINTS ? shapeSamples : null,
      regimeKey,
      sampledAtIso: newest.ts,
      sampleMachine: newest.machine,
      tokensTotal: null,
      usd: null,
      scope: provider === "claude" ? group.scope : null,
      sublimits: [],
      ...(segment ? { counterSegment: { startDrop: segment.drop, endDrop: segment.endDrop } } : {}),
      ...(accountMeters ? { accountMeters } : {}),
      ...(creditPools ? { creditPools } : {}),
      cadenceSegmentFrom: cadenceInsideWindow.segmentFrom,
      cadencePeriodSource: cadenceInsideWindow.periodSource,
      cadenceAnchorSource: group.resetIso == null ? "none" : "probe",
      cadenceSourceWon: cadenceInsideWindow.sourceWon,
      note: group.unstarted
        ? `Antigravity podaje pozostały czas; przy 0% zużycia pełne ${railDurationLabel(hours)} oznacza, ` +
          "że dynamiczne okno jeszcze się nie zaczęło i nie ma stałej kotwicy resetu."
        : `${segmentNote}${newest.manual ? `Pomiar ręczny: ${newest.manual.note || "bez opisu"} ` : ""}${newest.limitHit ? "Limit osiągnięty: Claude Code zapisał odmowę dostawcy (rate_limit, 100%) z resetem tego okna. " : ""}${probeRailNote(provider, newest, usedPercent, group.resetIso != null) ?? ""}`.trim() || null,
      newestTs: newest.ts,
      kind: group.kind,
      limitGroup: group.limitGroup,
      scopeKey: group.scope,
      unstarted: group.unstarted,
    });
  }
  const sorted = out.sort((a, b) => {
      if (provider === "gemini" && a.unstarted !== b.unstarted) return a.unstarted ? -1 : 1;
      const aKey = a.resetIso ? Date.parse(a.resetIso) : Date.parse(a.newestTs);
      const bKey = b.resetIso ? Date.parse(b.resetIso) : Date.parse(b.newestTs);
      return bKey - aKey || b.newestTs.localeCompare(a.newestTs);
    });
  const currentByLimit = new Set<string>();
  const mapped = sorted.map(({ newestTs: _newestTs, kind, limitGroup, scopeKey, unstarted: _unstarted, ...window }) => {
    const limitKey = window.counterKey ?? probeCounterKey(provider, kind, limitGroup, scopeKey);
    const isCurrent = window.isCurrent && !currentByLimit.has(limitKey);
    if (isCurrent) currentByLimit.add(limitKey);
    return { ...window, isCurrent };
  });
  const matched = new Set(railGroups.flatMap(group => group.register?.manual_measurements?.map(m => m.id) ?? []));
  const planIndex = planPeriodIndex(planPeriods);
  const standalone: RailWindow[] = measurements.filter(m => !matched.has(m.id)).flatMap(m => {
    const counter = parseCapacityCounter(m.counter);
    if (!counter) return [];
    const [kind, group, minutes] = counter;
    const firstPlan = planIndex?.resolve(provider, account, m.start).value ?? null;
    const lastPlan = planIndex?.resolve(provider, account, new Date(Date.parse(m.end) - 1).toISOString()).value ?? null;
    const plan = firstPlan === lastPlan ? firstPlan : null;
    return [{ key: `manual:${m.id}`, counterKey: probeCounterKey(provider, kind, group, null),
      counterLabel: railDurationLabel(minutes / 60), label: railDurationLabel(minutes / 60),
      dateLabel: railDateLabel(m.start, m.end), source: "probe" as const, isCurrent: false,
      usedPercent: m.end_percent, percentBasis: "manual" as const, plan,
      elapsedPercent: 100, ppAhead: null, windowHours: minutes / 60,
      startIso: m.start, resetIso: m.end, shape: null,
      regimeKey: `${m.counter}:${plan ?? "unknown-plan"}:manual`, sampledAtIso: m.end,
      sampleMachine: null, tokensTotal: null, usd: null, scope: null, sublimits: [],
      note: `Pomiar ręczny: ${m.note || "bez opisu"}` }];
  });
  return [...mapped, ...standalone].sort((a, b) => (b.resetIso ?? "").localeCompare(a.resetIso ?? ""));
}

/**
 * The Grok rail without a current Billing window: the gauge's current window from stored rows. Its
 * rolling fallback ends at the newest call and is never a measurement (source "rolling").
 */
function grokRailWindow(ctx: AppContext, account: string): RailWindow[] {
  const report = buildGrokLimit(ctx.sqlite, grokGaugeFor(ctx, account));
  const current = report.current;
  const hours = report.window_hours || 168;
  const measured = current?.percent_measured ?? null;
  const used = measured ?? current?.percent_est ?? null;
  const nowMs = Date.now();
  const startMs = current?.anchored ? Date.parse(current.window_start) : NaN;
  const endMs = current?.anchored ? Date.parse(current.window_end) : NaN;
  const elapsed = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? round2(Math.max(0, Math.min(100, ((nowMs - startMs) / (endMs - startMs)) * 100)))
    : null;
  return [{
    key: current?.anchored ? `billing:${current.window_end}` : "rolling:168h",
    counterKey: "grok:weekly:all",
    counterLabel: railDurationLabel(hours),
    label: railDurationLabel(hours),
    dateLabel: current?.anchored ? railDateLabel(current.window_start, current.window_end) : "kroczące",
    source: measured != null ? "probe" : "rolling",
    isCurrent: true,
    usedPercent: used,
    percentBasis: used == null ? null : measured != null ? "measured" : "counterfactual",
    elapsedPercent: elapsed,
    ppAhead: used != null && elapsed != null ? round2(used - elapsed) : null,
    windowHours: hours,
    startIso: current?.window_start ?? null,
    resetIso: current?.anchored ? current.window_end : null,
    shape: null,
    regimeKey: `grok:weekly:all:${hours}h`,
    sampledAtIso: null,
    sampleMachine: null,
    tokensTotal: current?.spend.gross ?? null,
    usd: current?.spend.usd ?? null,
    scope: null,
    sublimits: [],
    note: measured != null
      ? `Procent i reset konta ${account} odczytane z Billing zapisanego przez oficjalny CLI Groka. ` +
        "Tokeny i koszt pochodzą z lokalnego indeksu."
      : `Brak aktywnego odczytu Billing dla ${account}; pokazany procent jest fallbackiem z lokalnej kalibracji.`,
  }];
}

function observedCadence(ctx: AppContext, provider: string, subject: string, kind: string): ObservedCadence {
  return observedProbeCadence(ctx.sqlite, provider, subject, kind);
}

function claudeRailLabel(hours: number | null, scope: string | null): string {
  return scope ? `${railDurationLabel(hours)} · ${scope}` : railDurationLabel(hours);
}

/**
 * Claude windows reconstructed from the cadence for weeks the meter never reported. The window list and
 * its sums are the window producer's (`declared:` intervals of window_usage, plan U1.4); a reconstructed
 * window is never a measurement, and one without owned traffic while unowned traffic exists shows no
 * total rather than a confirmed zero (golden rules §8).
 */
function claudeAnchoredWindows(ctx: AppContext, account: string, nowMs: number,
  prepared?: ProbeRailRegister): RailWindow[] {
  const declared = readWindowIntervals(ctx.sqlite, "claude", account)
    .flatMap(interval => interval.kind === "declared" ? [interval] : []);
  if (declared.length === 0) return [];
  const configuredAccount = claudeAccountId(ctx.claudeGauge.subscription);
  const cfg: ClaudeGaugeConfig = configuredAccount && account.toLowerCase() === configuredAccount.toLowerCase()
    ? ctx.claudeGauge : { vendor: "claude", subscription: account, plan: "unknown", window_hours: 168, session_hours: 5, observations: [] };
  let periods = prepared?.periods ?? [];
  if (!prepared) try { periods = loadPeriods(ctx.sqlite, PLAN_PERIODS); }
  catch (error) { console.warn("[windows] plan periods unreadable:", error instanceof Error ? error.message : error); }
  const planIndex = planPeriodIndex(periods);
  const accountPlans = effectiveDatedPeriods(periods).filter(p => p.provider === "claude" && p.subject.toLowerCase() === account.toLowerCase());
  const price = (model: string | null, day: string, speed: string | null) =>
    getClaudeRate(ctx.rateCards, model, day, speed);
  const limitReport = buildClaudeLimit(ctx.sqlite, cfg, price, new Date(nowMs).toISOString(),
    { rateCards: ctx.rateCards, eras: ctx.eras, resolver: accountResolverOf(ctx), cycles: ctx.cycles, planPeriods: periods,
      probeEvidence: prepared?.evidence, probeWindows: prepared?.weeklyWindows, probeReadings: prepared?.readings,
      manualCapacity: prepared?.measurements });
  // Reconstructed percentages require explicit manual calibration; a weekly Code
  // share does not justify dividing all local traffic or another window by it.
  const calibration = limitReport.calibration?.basis === "manual" ? limitReport.calibration : null;
  const sums = readSpanSums(ctx.sqlite, "claude", account, declared.map(interval => interval.id), ["cycle", "rail"]);
  const out: RailWindow[] = [];
  // Kinds in their declared order, newest window first within a kind.
  const kinds = [...new Set(declared.map(interval => interval.declared.kind))];
  for (const interval of [...declared].sort((a, b) => kinds.indexOf(a.declared.kind) - kinds.indexOf(b.declared.kind)
    || b.declared.window.startMs - a.declared.window.startMs)) {
    const window = interval.declared.window, spec = { kind: interval.declared.kind, scope: interval.declared.scope };
    const scoped = spec.kind === "weekly_scoped";
    const basePerPoint = scoped ? calibration?.usd_per_point_fable ?? null : calibration?.usd_per_point ?? null;
    const calBoost = calibration?.boost_factor && calibration.boost_factor > 0 ? calibration.boost_factor : 1;
    const isCurrent = window.startMs <= nowMs && nowMs < window.resetMs;
    const windowPlan = probeWindowPlan(planIndex, accountPlans, "claude", account, window.startIso, window.resetIso);
    const periodHours = window.periodHours;
    const label = claudeRailLabel(periodHours, spec.scope);
    const stored = sums.get(interval.id)!;
    const spend = totalSpend(stored.cycle.spend ?? []);
    const hasIndexedUsage = spend.events > 0;
    // Traffic of this span that no account owns: the empty window is missing ownership, not zero usage.
    const unowned = !hasIndexedUsage && (stored.rail.unowned?.events ?? 0) > 0 ? stored.rail.unowned! : null;
    const perPoint =
      basePerPoint != null && basePerPoint > 0
        ? (basePerPoint / calBoost) * boostFactorAt(cfg, window.startIso)
        : null;
    const usedPercent = hasIndexedUsage && perPoint != null && perPoint > 0 ? round2(spend.actual / perPoint) : null;
    const days = Math.max(1, Math.round(periodHours / 24));
    const gaps =
      hasIndexedUsage && stored.rail.days.length < days
        ? ` Indeks ma zdarzenia w ${stored.rail.days.length} z ${days} dni tego okna.`
        : "";
    const unpricedShare = stored.rail.tokens > 0 ? stored.rail.unpriced_tokens / stored.rail.tokens : 0;
    const unpricedModels = [...new Set(stored.rail.unpriced_groups.map(group => group.model ?? "unknown"))].sort();
    const unpriced =
      unpricedShare > 0.01
        ? ` UWAGA: ${(unpricedShare * 100).toFixed(0)}% tokenów tego okna to modele bez karty cennika ` +
          `(${unpricedModels.join(", ")}) - ich koszt liczy się jako zero, więc procent jest ZANIŻONY.`
        : "";
    const anchorIsoStr = window.anchorIso;
    const anchorSrc = window.anchorSource;
    const reconstructed: ProbeRailWindow & {
      cadenceSegmentFrom: string | null;
      cadencePeriodSource: CadenceSource;
      cadenceAnchorSource: CadenceSource;
      cadenceSourceWon: CadenceSource;
    } = {
      key: `${spec.kind}:${window.resetIso}`,
      counterKey: probeCounterKey("claude", spec.kind, null, spec.scope),
      parentCounterKey: spec.scope
        ? probeCounterKey("claude", probeParentKind(spec.kind), null, null)
        : null,
      counterLabel: railDurationLabel(periodHours),
      label,
      dateLabel: railDateLabel(window.startIso, window.resetIso),
      source: window.source === "probe" ? "probe" : "declared",
      plan: windowPlan.plan,
      plan_detail: windowPlan.plan_detail,
      declared_plan_meter_mismatch: windowPlan.declared_plan_meter_mismatch,
      isCurrent,
      usedPercent,
      percentBasis: usedPercent == null ? null : "counterfactual",
      elapsedPercent: isCurrent
        ? round2(windowElapsedPercent(window.startMs, periodHours, nowMs))
        : 100,
      ppAhead: null,
      windowHours: periodHours,
      startIso: window.startIso,
      resetIso: window.resetIso,
      shape: null,
      regimeKey: `${probeCounterKey("claude", spec.kind, null, spec.scope)}:unknown-plan@${window.resetIso}:${periodHours}h`,
      sampledAtIso: null,
      sampleMachine: null,
      tokensTotal: unowned ? null : spend.tokens,
      usd: unowned ? null : round2(spend.actual),
      scope: spec.scope,
      sublimits: [],
      cadenceSegmentFrom: window.segmentFrom ?? null,
      cadencePeriodSource: window.periodSource,
      cadenceAnchorSource: window.anchorSource,
      cadenceSourceWon: window.source,
      note:
        `Okno ODTWORZONE z rytmu: kotwica ${anchorIsoStr ? anchorIsoStr.slice(0, 16).replace("T", " ") + "Z" : "—"} ` +
        `(${anchorSrc === "declared" ? "cycles.json" : "reset z konta"}), co ${railDurationLabel(periodHours)}. ` +
        "Anthropic nigdy nie podał dla niego procentu. " +
        (hasIndexedUsage
          ? "Tokeny i dolary są ZMIERZONE z indeksu; "
          : unowned
            ? `W tym oknie jest ${unowned.events} wywołań (${unowned.tokens} tokenów) bez przypisanego konta, więc brak sumy oznacza brak pokrycia, nie zerowe zużycie. `
            : "Brak zaindeksowanych wywołań; wiersz pokazuje 0 tokenów/$0 z indeksu, ale nie dowodzi, że konto było wtedy aktywne ani że użycie poza indeksem wynosiło zero. ") +
        (usedPercent == null
          ? hasIndexedUsage
            ? "Procentu nie ma, bo brak kalibracji kursu punktu."
            : "Procentu nie ma, bo puste okno nie ma zaindeksowanego kosztu do przeliczenia."
          : `Procent jest WYLICZONY z tych dolarów kursem $${perPoint!.toFixed(2)}/pkt i mówi, ile z DZISIEJSZEGO limitu zjadłoby to okno.`) +
        gaps +
        unpriced,
    };
    out.push(reconstructed);
  }
  return out;
}

function mergeRailWindows(measured: RailWindow[], declared: RailWindow[]): RailWindow[] {
  const covered = (row: RailWindow): boolean =>
    measured.some((m) => m.label === row.label && sameResetWindow(m.resetIso, row.resetIso));
  const merged = [...measured, ...declared.filter((row) => !covered(row))];
  return merged.sort((a, b) => {
    const ak = a.resetIso ? Date.parse(a.resetIso) : 0;
    const bk = b.resetIso ? Date.parse(b.resetIso) : 0;
    return bk - ak || a.label.localeCompare(b.label);
  });
}

function foldRailSublimits(windows: RailWindow[]): RailWindow[] {
  const hosts = windows.filter((row) => row.scope == null);
  const scoped = windows.filter((row) => row.scope != null);
  if (scoped.length === 0) return windows;
  const attached = new Set<RailWindow>();
  const byHost = new Map<RailWindow, RailWindow[]>();
  for (const row of scoped) {
    const candidates = hosts
      .filter((host) => row.windowHours === host.windowHours && sameResetWindow(row.resetIso, host.resetIso))
      .sort((a, b) => (a.counterKey ?? a.key).localeCompare(b.counterKey ?? b.key));
    const host = row.parentCounterKey != null
      ? candidates.find((candidate) => candidate.counterKey === row.parentCounterKey) ?? null
      : candidates[0] ?? null;
    if (!host) continue;
    const mine = byHost.get(host) ?? [];
    mine.push(row);
    byHost.set(host, mine);
    attached.add(row);
  }
  const out = hosts.map((host) => {
    const mine = byHost.get(host) ?? [];
    if (mine.length === 0) return host;
    return {
      ...host,
      sublimits: mine.map((row) => ({
        counterKey: row.counterKey,
        label: row.scope!,
        usedPercent: row.usedPercent,
        percentBasis: row.percentBasis,
        shape: row.shape,
        activityShape: row.activityShape,
        regimeKey: row.regimeKey,
        sampledAtIso: row.sampledAtIso,
        sampleMachine: row.sampleMachine,
        trafficByMachine: row.trafficByMachine,
        tokensTotal: row.tokensTotal,
        usd: row.usd,
        note: row.note,
      })),
    } satisfies RailWindow;
  });
  const orphans = scoped.filter((row) => !attached.has(row));
  return [...out, ...orphans].sort((a, b) => {
    const ak = a.resetIso ? Date.parse(a.resetIso) : 0;
    const bk = b.resetIso ? Date.parse(b.resetIso) : 0;
    return bk - ak || a.label.localeCompare(b.label);
  });
}

/**
 * Closed Claude windows whose meter readings stopped before the end show their stored end estimate instead of the
 * last reading, as a computed percent ("counterfactual": the rail's existing ≈), with the estimate's provenance in
 * `endEstimate` and the note. The open window, a measured 100 % and the readings themselves stay as measured.
 */
function attachClosedWindowEstimates(ctx: AppContext, account: string, windows: RailWindow[], nowMs: number): RailWindow[] {
  const estimates = readWindowEndEstimates(ctx.sqlite, "claude", account);
  if (!estimates.size) return windows;
  const day = (iso: string) => iso.slice(0, 16).replace("T", " ") + "Z";
  return windows.map((window) => {
    const estimate = estimates.get((window as ProbeRailWindow).windowId ?? "");
    if (!estimate || estimate.basis !== "estimate" || window.isCurrent || !window.resetIso || Date.parse(window.resetIso) > nowMs
      || window.usedPercent == null || window.percentBasis !== "measured" || estimate.percent <= window.usedPercent) return window;
    const calibration = estimate.calibration!, after = estimate.after!;
    const note = `Szacunek końca okna: ostatni odczyt konta ${estimate.last_reading.percent}% (${day(estimate.last_reading.ts)}), ` +
      `potem do końca okna ${after.tokens.toLocaleString("pl-PL")} tokenów (≈$${after.api_actual.toFixed(0)} API) ` +
      `przy kursie $${calibration.usd_per_point.toFixed(2)} za 1% z ${calibration.source === "window" ? "odczytów tego okna" : "poprzedniego okna"} ` +
      `(${calibration.from.percent}%→${calibration.to.percent}%) daje ≈${round2(estimate.percent)}%` +
      `${estimate.uncapped != null && estimate.uncapped > 100 ? " (górna granica 100%)" : ""}. Wartość wyliczona, nie odczyt konta.` +
      `${after.unpriced_events > 0 ? ` ${after.unpriced_events} wywołań bez ceny nie weszło do szacunku.` : ""}`;
    return { ...window, usedPercent: round2(estimate.percent), percentBasis: "counterfactual" as const,
      ppAhead: window.ppAhead == null ? null : round2(window.ppAhead + estimate.percent - window.usedPercent),
      endEstimate: estimate, note: window.note ? `${note} ${window.note}` : note } satisfies ProbeRailWindow;
  });
}

/** The stored row behind a non-Codex rail window: its limit window, manual measurement or reconstructed window. */
function railSpanId(window: RailWindow): string | null {
  const windowId = (window as ProbeRailWindow).windowId;
  if (windowId) return windowId;
  if (window.key.startsWith("manual:")) return window.key;
  const kind = window.key.slice(0, window.key.indexOf(":"));
  return (kind === "weekly_all" || kind === "weekly_scoped") && window.startIso && window.resetIso
    && window.key === `${kind}:${window.resetIso}` ? `declared:${kind}:${window.startIso}:${window.resetIso}` : null;
}

/**
 * Tokens per machine of a window's stored archive sources, as the rail shows them. A ledger source is
 * the archive folder key (`claude/<folder>`) or, for OpenCode, `glm/<store>`; machines are declared on
 * the archive folder or, for OpenCode, on the store.
 */
function railMachines(ctx: AppContext, provider: string, account: string,
  sources: ReadonlyArray<{ name: string; first: string; tokens: number }>): RailTrafficShare[] {
  const address = (name: string) => normEraVendor(provider) === "glm" ? name.replace(/^glm\//, "")
    : archiveFolderOf(name, ARCHIVE_LOGICAL_ROOT) || !name.includes("/") ? name : `${ARCHIVE_LOGICAL_ROOT}/${name}`;
  const machines = new Map<string, RailTrafficShare>();
  for (const source of sources) {
    const machine = machineForActivitySource(ctx, provider, address(source.name), source.first, account)?.trim() || null, key = machine?.toLowerCase() ?? "";
    const row = machines.get(key) ?? { machine, amount: 0 };
    row.amount += source.tokens; machines.set(key, row);
  }
  return [...machines.values()].filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount);
}

/**
 * Rail activity of a non-Codex rail (plan U1.4): the cumulative curve and the traffic per machine of
 * each window come from its stored row in window_usage, the Claude Fable sublimit from the row's
 * scoped part. A window without a stored span (an unstarted or unanchored window, the Grok rolling
 * fallback) keeps no curve; a missing row raises WindowUsagePreparing. Values are drawn as before
 * (AGENTS.md: the approved UI stays).
 */
function attachRailActivity(
  ctx: AppContext,
  provider: string,
  account: string,
  windows: RailWindow[]
): RailWindow[] {
  if (normEraVendor(provider) === "codex") return windows;
  const ids = windows.flatMap(window => window.startIso && window.resetIso ? railSpanId(window) ?? [] : []);
  const stored = readSpanSums(ctx.sqlite, normEraVendor(provider), account, ids, ["rail"]);
  // A window with traffic-free bounds still draws a flat line, as the rail always has.
  const curve = (activity: Array<{ t: number; amount: number }>) => activity.length ? activity : [{ t: 0, amount: 0 }, { t: 100, amount: 0 }];
  return windows.map((window) => {
    const id = window.startIso && window.resetIso ? railSpanId(window) : null;
    const row = id ? stored.get(id) : undefined;
    const muted = provider === "gemini" && !window.label.toLowerCase().includes("gemini");
    const activityShape = row && !muted ? curve(row.rail.activity) : null;
    const trafficByMachine = row && !muted ? railMachines(ctx, provider, account, row.rail.sources) : [];
    const scoped = row?.rail.scoped;
    return {
      ...window,
      activityShape,
      trafficByMachine,
      sublimits: window.sublimits.map((sub) => {
        const fable = provider === "claude" && sub.label.toLowerCase() === "fable";
        return { ...sub,
          activityShape: fable ? row && scoped ? curve(scoped.activity) : null : activityShape,
          trafficByMachine: fable ? scoped ? railMachines(ctx, provider, account, scoped.sources) : [] : trafficByMachine };
      }),
    };
  });
}

/**
 * Each Claude weekly window gets the whole-account split of its own last reading, selected from
 * one prepared report (plan §3.2.2). A window whose readings carry no product rows gets none.
 * Facts still being prepared leave the rail unsplit rather than waiting behind the preparation.
 */
function attachClaudeAccountSplits(ctx: AppContext, account: string, windows: RailWindow[],
  prepared?: ProbeRailRegister): RailWindow[] {
  const weekly = (window: RailWindow) => window.windowHours === 168 && !window.scope && window.resetIso != null;
  if (!windows.some(weekly)) return windows;
  let report: ReturnType<typeof buildClaudeCodeCapacityReport>;
  try {
    report = buildClaudeCodeCapacityReport(ctx.sqlite, account, { rateCards: ctx.rateCards, eras: ctx.eras,
      cycles: ctx.cycles, planPeriods: prepared?.periods, manualCapacity: prepared?.measurements,
      probeEvidence: prepared?.evidence, probeWindows: prepared?.weeklyWindows, probeReadings: prepared?.readings });
  } catch (error) {
    if (error instanceof SubscriptionFactsPending || error instanceof WindowUsagePreparing) return windows;
    throw error;
  }
  const newestFirst = [...report.observations].reverse();
  return windows.map((window) => {
    if (!weekly(window)) return window;
    // One vendor week can arrive with resets a second apart; the window's latest reading names it.
    const resetAt = newestFirst.find((observation) => sameResetWindow(observation.reset_at, window.resetIso))?.reset_at;
    if (!resetAt) return window;
    const summary = claudeCodeCapacitySummary(selectClaudeCodeCapacityReport(report,
      { windowId: (window as ProbeRailWindow).windowId, resetAt }));
    return { ...window, accountSplit: claudeAccountSplit(summary),
      claude_capacity: readClaudeCapacityResult(ctx.sqlite, summary, prepared?.weeklyWindows) };
  });
}

/**
 * Whole-account splits of every Claude weekly window that STARTED inside [since, until] (UTC days),
 * the current one as of its latest reading. A window is never cut: its share describes the meter
 * from its own reset, so a window that began before `since` is left out rather than prorated.
 */
export function handleClaudeAccountSplits(ctx: AppContext, url: URL): Response {
  const since = url.searchParams.get("since") ?? "", until = url.searchParams.get("until") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < since) {
    return Response.json({ error: "potrzebne `since` i `until` (YYYY-MM-DD, since ≤ until)" }, { status: 400 });
  }
  const from = Date.parse(`${since}T00:00:00.000Z`), untilExclusive = Date.parse(`${until}T00:00:00.000Z`) + 86_400_000;
  const resolver = accountResolverOf(ctx);
  const accounts = resolver.accounts("claude").filter(account => claudeAccountId(account) !== null);
  const windows: ClaudeAccountSplitWindow[] = [];
  for (const account of accounts) {
    let report: ReturnType<typeof buildClaudeCodeCapacityReport>;
    try {
      // One read of the account's readings serves the limit samples and the observations (as the rail reads them).
      const readings = readPreparedProbeAccountReadings(ctx.sqlite, "claude", account);
      if (!readings) throw new ProbeAccountIndexUnavailable();
      report = buildClaudeCodeCapacityReport(ctx.sqlite, account, { rateCards: ctx.rateCards, eras: ctx.eras, resolver,
        cycles: ctx.cycles, probeReadings: readings, probeEvidence: probeLimitEvidenceOf(ctx.sqlite, "claude", account, resolver, readings.rows) },
        { since: new Date(from).toISOString(), untilExclusive: new Date(untilExclusive + 7 * 86_400_000).toISOString() });
    } catch (error) {
      if (error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable)
        return Response.json({ since, until, pending: true, windows: [] } satisfies ClaudeAccountSplitsResponse);
      throw error;
    }
    const chosen: string[] = [];
    for (const observation of [...report.observations].reverse()) {
      const start = observation.window_started_at, reset = observation.reset_at;
      if (!start || !reset || chosen.some((known) => sameResetWindow(known, reset))) continue;
      const startMs = Date.parse(start);
      if (!(startMs >= from && startMs < untilExclusive)) continue;
      chosen.push(reset);
      const split = claudeAccountSplit(claudeCodeCapacitySummary(selectClaudeCodeCapacityReport(report,
        { windowId: observation.window_id ?? undefined, resetAt: reset })));
      if (split) windows.push({ account, window_started_at: start, reset_at: reset, split });
    }
  }
  windows.sort((a, b) => a.account.localeCompare(b.account) || a.window_started_at.localeCompare(b.window_started_at));
  return Response.json({ since, until, pending: false, windows } satisfies ClaudeAccountSplitsResponse);
}

/** Rail fields of a stored Codex window: its stored sums, and the machine of each source that carried traffic. */
function codexRailUsage(ctx: AppContext, account: string, rail: WindowRailSums, cycle: WindowCycleSums) {
  const machines = new Map<string, { machine: string | null; amount: number }>();
  for (const source of cycle.evidence.sources) {
    const machine = machineForActivitySource(ctx, "codex", source.name, source.first, account), key = machine?.toLowerCase() ?? "";
    const row = machines.get(key) ?? { machine, amount: 0 };
    row.amount += source.tokens; machines.set(key, row);
  }
  return { tokensTotal: rail.tokens, usd: rail.api_standard,
    context_price: cycle.cycle_usage && storedContextPrice(cycle.cycle_usage),
    activityShape: rail.activity.length ? rail.activity : null,
    trafficByMachine: [...machines.values()].filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount),
    aggregation_partial: false, usd_approximate: rail.unpriced_tokens > 0, unpriced_tokens: rail.unpriced_tokens,
    unpricedGroups: rail.unpriced_groups };
}

/**
 * The window rail of one account (plan U1.3/U1.4): stored limit windows, their stored sums and the
 * producer's intervals, read on request (one read of the account's probe readings for the other providers);
 * no report preparation; the server builds it in a worker (`direct-read.ts`). The response is kept per data
 * stamp and minute (`CLOCK_CACHEABLE_ROUTES`).
 */
export async function handleWindows(ctx: AppContext, url: URL): Promise<Response> {
  try { return readWindowRail(ctx, url); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return preparingRows();
    throw error;
  }
}

/** The stored readings that carry a provider's pools: Codex on its main counter, Claude on its main weekly reading. */
const CREDIT_POOL_READINGS: Record<"codex" | "claude", { from: number; where: string }> = {
  codex: { from: CODEX_CREDITS_RECORDED_FROM,
    where: "p.limit_group='codex' AND (p.extra LIKE '%codex.credits.%' OR p.extra LIKE '%codex.reset_credits%')" },
  claude: { from: -Infinity,
    where: "p.kind='weekly_all' AND p.scope IS NULL AND (p.extra LIKE '%limit_dollars%' OR p.extra LIKE '%claude.raw.spend.%')" },
};

/**
 * Credit pools of each window from the account's readings that carry them: one owned index range over
 * the windows' span. The limit-window register keeps only percents, so the pools are read beside it.
 * A change is measured from the previous pool reading inside that span, so callers that show one window
 * pass the window before it too.
 */
export function windowCreditPools(ctx: AppContext, provider: "codex" | "claude", account: string,
  segments: readonly ProbeLimitWindow[]): Map<string, CreditPoolsOfRange> {
  const out = new Map<string, CreditPoolsOfRange>();
  if (segments.length === 0) return out;
  const bounds = segments.map(segment => [Date.parse(segment.start), Date.parse(segment.end)] as const);
  const from = Math.max(CREDIT_POOL_READINGS[provider].from, Math.min(...bounds.map(([start]) => start)));
  const until = Math.max(...bounds.map(([, end]) => end)) + 1;
  if (!(from < until)) return out;
  let samples: Array<{ ts: string; extra: string | null }>;
  try {
    const context = probeReadContext(ctx.sqlite);
    const predecessor = selectOwnedProbes(ctx.sqlite, context, provider, account, {
      from: CREDIT_POOL_READINGS[provider].from, until: from, order: "desc", limit: 1,
      columns: "p.id, p.extra", where: CREDIT_POOL_READINGS[provider].where,
    });
    samples = [...predecessor, ...selectOwnedProbes(ctx.sqlite, context, provider, account, {
      from, until, columns: "p.id, p.extra", where: CREDIT_POOL_READINGS[provider].where,
    })].map(probe => ({ ts: new Date(probe.at).toISOString(), extra: (probe.row.extra as string | null) ?? null }));
  } catch (error) {
    console.warn("[windows] credit pools unreadable:", error instanceof Error ? error.message : error);
    return out;
  }
  const readings = creditPoolReadings(provider, samples);
  if (readings.length === 0) return out;
  segments.forEach((segment, index) => {
    const [start, end] = bounds[index]!;
    const pools = creditPoolsInRange(readings, start, end);
    if (pools) out.set(segment.id, pools);
  });
  return out;
}

function readWindowRail(ctx: AppContext, url: URL): Response {
  const account = url.searchParams.get("account")?.trim();
  if (!account) return Response.json({ error: "Missing 'account' parameter" }, { status: 400 });
  if (account.endsWith("::business") && resolveAccountScope(ctx, account)) {
    return Response.json({ account, provider: "codex", source: "billing", windows: [] });
  }
  const probeColumns = probeWindowColumns(ctx.sqlite);
  const declaredProviders = new Set(
    ctx.eras.entriesOf(account).map((entry) => normEraVendor(entry.vendor))
  );
  const resolver = accountResolverOf(ctx);
  const candidates = new Set([...declaredProviders, "codex", "claude", "gemini", "glm", "grok"]);
  let providerRow: { provider: string; last_ts: string } | null = null;
  // The provider whose readings of the account are newest, from the current cards' stored activity.
  const cards = readCardHistories(ctx.sqlite);
  for (const candidate of candidates) {
    if (!declaredProviders.has(candidate) && !resolver.accounts(candidate).includes(account.toLowerCase())) continue;
    const last = cardActivity(cards, candidate, account)?.last?.ts;
    if (last && (!providerRow || last > providerRow.last_ts)) providerRow = { provider: candidate, last_ts: last };
  }
  const declaredProvider = declaredProviders.size === 1 ? [...declaredProviders][0]! : null;
  // A detected login with no readings yet is a known account with no windows, not an unknown one.
  const discoveredProvider = ctx.vendorDiscovery?.accounts.find((a) => a.id.toLowerCase() === account.toLowerCase())?.vendor ?? null;
  const provider = providerRow?.provider ?? declaredProvider ?? discoveredProvider;
  if (provider === "codex") {
    const minutes = url.searchParams.get("window") === "300" ? 300 : 10080;
    let segments: ProbeLimitWindow[];
    try { segments = codexVisibleLimitWindows(readCodexLimitWindows(ctx.sqlite, account, minutes)); }
    catch (error) {
      if (error instanceof LimitWindowsPreparing) return preparingRows();
      throw error;
    }
    const now = Date.now();
    const creditPools = windowCreditPools(ctx, "codex", account, segments);
    const windows: ProbeRailWindow[] = segments.map((segment, index): ProbeRailWindow => {
      const start = Date.parse(segment.start), end = Date.parse(segment.end);
      const last = segment.readings.at(-1)!;
      const elapsed = Math.max(0, Math.min(100, (now - start) / (end - start) * 100));
      return { key: segment.id, windowId: segment.id,
        counterKey: `codex:codex:${minutes / 60}h`, counterLabel: railDurationLabel(minutes / 60),
        label: `#${index + 1}`, dateLabel: railDateLabel(segment.start, segment.end), source: "cycle",
        isCurrent: start <= now && now < end, usedPercent: last.percent,
        percentBasis: last.source === "manual" ? "manual" : "measured",
        plan: segment.plan, plan_detail: segment.plan_detail,
        declared_plan_meter_mismatch: segment.declared_plan_meter_mismatch,
        cycle_end_basis: segment.cycle_end_basis,
        manual_measurement: segment.manual_measurement, manual_measurements: segment.manual_measurements,
        elapsedPercent: elapsed, ppAhead: last.percent - elapsed, windowHours: minutes / 60,
        startIso: segment.start, resetIso: segment.end,
        shape: segment.readings.length >= MIN_RAIL_SHAPE_POINTS ? segment.readings.map(reading => ({
          t: Math.max(0, Math.min(100, (Date.parse(reading.ts) - start) / (end - start) * 100)),
          pct: reading.percent })) : null,
        activityShape: null, regimeKey: `codex:codex:${minutes}m:${segment.plan ?? "mixed"}`,
        sampledAtIso: last.ts, sampleMachine: null, trafficByMachine: [], tokensTotal: null, usd: null,
        note: null, scope: null, sublimits: [],
        ...(creditPools.has(segment.id) ? { creditPools: creditPools.get(segment.id) } : {}),
      };
    });
    windows.sort((a, b) => (b.resetIso ?? "").localeCompare(a.resetIso ?? ""));
    let sums: ReturnType<typeof readWindowSums<"rail" | "cycle">>;
    try { sums = readWindowSums(ctx.sqlite, "codex", account, codexLimitCounter(minutes), segments, ["rail", "cycle"]); }
    catch (error) {
      if (error instanceof WindowUsagePreparing) return preparingRows();
      throw error;
    }
    // A standalone manual interval is not a stored window and has no stored sums.
    const preparedWindows = windows.map(window => {
      const stored = sums.get(window.windowId ?? "");
      return stored ? { ...window, ...codexRailUsage(ctx, account, stored.rail, stored.cycle), aggregation_status: "prepared" as const } : window;
    });
    return Response.json({
      account,
      provider: "codex",
      source: "cycle",
      windows: preparedWindows,
    });
  }
  if (provider && ["claude", "glm", "gemini", "grok"].includes(provider)) {
    const nowMs = Date.now();
    const read = () => withReadSnapshot(ctx.sqlite, () => {
      let periods: DatedPeriod[] = [];
      try { periods = loadPeriods(ctx.sqlite, PLAN_PERIODS); }
      catch (error) { console.warn("[windows] plan periods unreadable:", error instanceof Error ? error.message : error); }
      let measurements: ManualCapacityMeasurement[] = [];
      try { measurements = ctx.manualCapacity ?? readManualCapacity(provider).measurements; }
      catch (error) { console.warn("[windows] manual measurements unreadable:", error instanceof Error ? error.message : error); }
      // One read of the account's readings serves the rail samples, the Claude report and its Code estimate.
      const readings = readPreparedProbeAccountReadings(ctx.sqlite, provider, account);
      if (!readings) throw new ProbeAccountIndexUnavailable();
      const evidence = probeLimitEvidenceOf(ctx.sqlite, provider, account, resolver, readings.rows);
      const weeklyWindows = provider === "claude" ? claudeWeeklyRegisterWindows(ctx.sqlite, account) : undefined;
      const prepared: ProbeRailRegister = { evidence, periods, measurements, weeklyWindows, readings };
      return { measured: probeRailWindows(ctx, provider, account, nowMs, prepared), prepared };
    });
    let rail: ReturnType<typeof read>;
    try { rail = read(); }
    catch (error) {
      if (error instanceof LimitWindowsPreparing) return preparingRows();
      throw error;
    }
    const { measured, prepared } = rail;
    try {
      const declared = provider === "claude" ? claudeAnchoredWindows(ctx, account, nowMs, prepared) : [];
      const fallback = provider === "grok" && !measured.some((window) => window.isCurrent)
        ? grokRailWindow(ctx, account)
        : [];
      const windows = foldRailSublimits(mergeRailWindows(measured, [...declared, ...fallback]));
      return Response.json({
        account,
        provider,
        source: declared.length > 0 ? "probe+declared" : fallback.length > 0 ? "probe+rolling" : "probe",
        windows: attachRailActivity(ctx, provider, account, provider === "claude"
          ? attachClosedWindowEstimates(ctx, account, attachClaudeAccountSplits(ctx, account, windows, prepared), nowMs) : windows),
      });
    } catch (error) {
      if (error instanceof WindowUsagePreparing) return preparingRows();
      throw error;
    }
  }
  if (account.toLowerCase() === grokGaugeAccount(ctx.grokGauge ?? {})
    || grokAccounts(ctx).some((id) => id.toLowerCase() === account.toLowerCase())) {
    return Response.json({
      account,
      provider: "grok",
      source: "rolling",
      windows: attachRailActivity(ctx, "grok", account, grokRailWindow(ctx, account)),
    });
  }
  return Response.json({ error: `unknown account: ${account}` }, { status: 400 });
}
