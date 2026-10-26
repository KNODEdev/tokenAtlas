import type { TokenVector, PlansCatalog } from "./plans-catalog";
import type { ObservationSlice, TokenRates, PlanWindowObservation, SampleDiagnostic, AdmittedSample } from "./plan-capacity-contracts";
import { resolveProviderGroup } from "./plans-catalog";
import { inclusiveEndDay, versionOnDay } from "./plan-capacity-periods";
import type { RateCard } from "./pricing";
import { evaluateGaugeQuality } from "./capacity-equivalents";
import { resolveCodexAccountingConfig, normalizeCodexEvent, longContextPremium } from "./codex-accounting-pricing";
import { scalePartial, sumPartial, normalizeVector } from "./plan-capacity-quantities";
import { resolveRates, valueFromSlices, valueVector } from "./plan-capacity-pricing";

export interface Candidate {
  window_id: string;
  start_ts: string;
  end_ts: string;
  first_percent: number;
  peak_percent: number;
  sample_count: number;
  lag_fraction?: number | null;
  distinct_steps?: number | null;
  tokens: Partial<TokenVector>;
  slices?: ObservationSlice[];
  cadence_hours: number;
  rates?: TokenRates;
  capacity_factor: number;
  capacity_regime_id: string | null;
  obs: PlanWindowObservation;
}

export function candidatesForTarget(
  catalog: PlansCatalog,
  obs: PlanWindowObservation,
  groupId: string,
  planId: string,
  targetVersion: string,
  windowKind: string
): { candidates: Candidate[]; diagnostic: SampleDiagnostic | null } {
  if (obs.exclusion_reason) {
    return {
      candidates: [],
      diagnostic: {
        window_id: obs.window_id,
        accepted: false,
        reason: obs.exclusion_reason,
        quality: null,
        start_ts: obs.start_ts,
        end_ts: obs.end_ts,
      },
    };
  }
  if (obs.window_kind !== windowKind) return { candidates: [], diagnostic: null };
  if (obs.plan_id !== planId) return { candidates: [], diagnostic: null };
  const group = resolveProviderGroup(catalog, obs.provider_alias);
  if (group.kind !== "ok" || group.group.id !== groupId) return { candidates: [], diagnostic: null };
  const startDay = obs.start_ts.slice(0, 10);
  const endDay = inclusiveEndDay(obs.start_ts, obs.end_ts);
  const startVer = versionOnDay(catalog, obs.provider_alias, obs.plan_id, startDay);
  const endVer = versionOnDay(catalog, obs.provider_alias, obs.plan_id, endDay);
  const same = startVer != null && startVer === endVer;
  if (same && startVer === targetVersion) {
    return {
      candidates: [
        {
          window_id: obs.window_id,
          start_ts: obs.start_ts,
          end_ts: obs.end_ts,
          first_percent: obs.first_percent,
          peak_percent: obs.peak_percent,
          sample_count: obs.sample_count,
          lag_fraction: obs.lag_fraction,
          distinct_steps: obs.distinct_steps,
          tokens: obs.tokens,
          slices: obs.slices,
          cadence_hours: obs.cadence_hours,
          rates: obs.rates,
          capacity_factor: obs.capacity_factor ?? 1,
          capacity_regime_id: obs.capacity_regime_id ?? null,
          obs,
        },
      ],
      diagnostic: null,
    };
  }
  if (same) return { candidates: [], diagnostic: null };
  const overlapsTarget = startVer === targetVersion || endVer === targetVersion;
  const parts = obs.parts ?? [];
  if (parts.length === 0) {
    if (!overlapsTarget && startVer !== targetVersion && endVer !== targetVersion) {
      return { candidates: [], diagnostic: null };
    }
    return {
      candidates: [],
      diagnostic: {
        window_id: obs.window_id,
        accepted: false,
        reason: "cross_version_unattributable",
        quality: null,
        start_ts: obs.start_ts,
        end_ts: obs.end_ts,
      },
    };
  }
  const candidates: Candidate[] = [];
  let anyUnattributable = false;
  for (const part of parts) {
    const pStart = part.start_ts.slice(0, 10);
    const pEnd = inclusiveEndDay(part.start_ts, part.end_ts);
    const pStartVer = versionOnDay(catalog, obs.provider_alias, obs.plan_id, pStart);
    const pEndVer = versionOnDay(catalog, obs.provider_alias, obs.plan_id, pEnd);
    if (pStartVer == null || pStartVer !== pEndVer) {
      anyUnattributable = true;
      continue;
    }
    if (pStartVer !== targetVersion) continue;
    candidates.push({
      window_id: `${obs.window_id}:${pStartVer}`,
      start_ts: part.start_ts,
      end_ts: part.end_ts,
      first_percent: part.first_percent,
      peak_percent: part.peak_percent,
      sample_count: part.sample_count,
      lag_fraction: part.lag_fraction,
      distinct_steps: part.distinct_steps,
      tokens: part.tokens,
      slices: part.slices,
      cadence_hours: obs.cadence_hours,
      rates: obs.rates,
      capacity_factor: obs.capacity_factor ?? 1,
      capacity_regime_id: obs.capacity_regime_id ?? null,
      obs,
    });
  }
  if (candidates.length > 0) return { candidates, diagnostic: null };
  if (!overlapsTarget && !anyUnattributable) return { candidates: [], diagnostic: null };
  return {
    candidates: [],
    diagnostic: {
      window_id: obs.window_id,
      accepted: false,
      reason: "cross_version_unattributable",
      quality: null,
      start_ts: obs.start_ts,
      end_ts: obs.end_ts,
    },
  };
}

function normalizeIso(ts: string): string {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ts;
}

export function resetIntervalKey(obs: {
  subscription_id?: string;
  window_kind: string;
  start_ts: string;
  end_ts: string;
}): string {
  return `${(obs.subscription_id ?? "").toLowerCase()}|${obs.window_kind}|${normalizeIso(obs.start_ts)}|${normalizeIso(obs.end_ts)}`;
}

export function dedupe(candidates: Candidate[]): { kept: Candidate[]; rejected: SampleDiagnostic[] } {
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = resetIntervalKey({
      subscription_id: c.obs.subscription_id,
      window_kind: c.obs.window_kind,
      start_ts: c.start_ts,
      end_ts: c.end_ts,
    });
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }
  const kept: Candidate[] = [];
  const rejected: SampleDiagnostic[] = [];
  const keys = [...byKey.keys()].sort();
  for (const key of keys) {
    const list = byKey.get(key)!;
    const ranked = [...list].sort((a, b) => {
      if (b.sample_count !== a.sample_count) return b.sample_count - a.sample_count;
      const end = b.end_ts.localeCompare(a.end_ts);
      if (end !== 0) return end;
      return a.window_id.localeCompare(b.window_id);
    });
    const winner = ranked[0]!;
    kept.push(winner);
    for (const extra of ranked.slice(1)) {
      rejected.push({
        window_id: extra.window_id,
        accepted: false,
        reason: "duplicate_window",
        quality: null,
        start_ts: extra.start_ts,
        end_ts: extra.end_ts,
      });
    }
  }
  kept.sort((a, b) => a.start_ts.localeCompare(b.start_ts) || a.window_id.localeCompare(b.window_id));
  return { kept, rejected };
}

export function admit(
  candidate: Candidate,
  card: RateCard,
  groupId: string
): { sample: AdmittedSample | null; diagnostic: SampleDiagnostic } {
  const quality = evaluateGaugeQuality({
    sample_count: candidate.sample_count,
    first_percent: candidate.first_percent,
    peak_percent: candidate.peak_percent,
    lag_fraction: candidate.lag_fraction,
    distinct_steps: candidate.distinct_steps,
  });
  const span = quality.span_percent;
  if (!quality.accepted) {
    return {
      sample: null,
      diagnostic: {
        window_id: candidate.window_id,
        accepted: false,
        reason: "first_gate_rejected",
        quality,
        start_ts: candidate.start_ts,
        end_ts: candidate.end_ts,
      },
    };
  }
  // Explicit custom rates are caller-supplied reference observations, not imported usage.
  if (groupId === "openai" && !candidate.rates && !(candidate.slices?.length && candidate.slices.every(slice=>slice.context_classified))) {
    const config = resolveCodexAccountingConfig(card);
    const normalized: ObservationSlice[] = [];
    for (const slice of candidate.slices ?? []) {
      if (slice.context_classified && slice.rates) { normalized.push(slice); continue; }
      if(slice.context_classified===false)return {sample:null,diagnostic:{window_id:candidate.window_id,accepted:false,
        reason:slice.speed==="unknown"?"unknown_speed":"missing_rate",quality,start_ts:candidate.start_ts,end_ts:candidate.end_ts}};
      const t = slice.tokens;
      const result = normalizeCodexEvent(config, { model: slice.model, speed: slice.speed,
        ts: `${slice.day}T00:00:00Z`, in_tok: (t.in_uncached ?? NaN) + (t.in_cache_read ?? NaN),
        cached_in: t.in_cache_read ?? NaN, cache_write: (t.in_cache_write_5m ?? 0) + (t.in_cache_write_1h ?? 0), out_tok: t.out_total ?? NaN });
      if (result.multiplier == null || result.normalized_usd == null) {
        return { sample: null, diagnostic: { window_id: candidate.window_id, accepted: false,
          reason: result.reason ?? "missing_rate", quality, start_ts: candidate.start_ts, end_ts: candidate.end_ts } };
      }
      const standard = config.rules.find(r => r.model === slice.model && r.speed === "standard" && r.billing_basis === "api_equivalent_usd"
        && r.valid_from <= slice.day && (!r.valid_until || slice.day < r.valid_until))!;
      const input = (t.in_uncached ?? 0) + (t.in_cache_read ?? 0);
      const rates = standard.long_context && longContextPremium(config) && input > standard.long_context.above_input_tokens ? standard.long_context.rates : standard.rates;
      normalized.push({ ...slice, speed: "standard", rates: { ...rates, in_cache_write_5m: 0, in_cache_write_1h: 0 }, tokens: Object.fromEntries(
        Object.entries(t).map(([key, value]) => [key, value! * result.multiplier!])) });
    }
    if (!normalized.length) return { sample: null, diagnostic: { window_id: candidate.window_id,
      accepted: false, reason: "unknown_speed", quality, start_ts: candidate.start_ts, end_ts: candidate.end_ts } };
    candidate = { ...candidate, slices: normalized };
  }
  const capacityFactor = candidate.capacity_factor;
  if (!(Number.isFinite(capacityFactor) && capacityFactor > 0)) {
    return { sample: null, diagnostic: { window_id: candidate.window_id, accepted: false,
      reason: "invalid_capacity_factor", quality, start_ts: candidate.start_ts, end_ts: candidate.end_ts } };
  }
  if (capacityFactor !== 1) {
    const inverse = 1 / capacityFactor;
    candidate = {
      ...candidate,
      tokens: scalePartial(candidate.tokens, inverse),
      slices: candidate.slices?.map((slice) => ({ ...slice, tokens: scalePartial(slice.tokens, inverse) })),
    };
  }
  // A share only describes the whole window it was read for, never one version part of it.
  const share = candidate.window_id === candidate.obs.window_id ? candidate.obs.local_share_percent : undefined;
  if (share != null) {
    if (!(Number.isFinite(share) && share > 0 && share <= 100)) {
      return { sample: null, diagnostic: { window_id: candidate.window_id, accepted: false,
        reason: share === 0 ? "share_zero" : "share_invalid", quality, start_ts: candidate.start_ts,
        end_ts: candidate.end_ts, local_share_percent: share } };
    }
    // The share covers the meter from the window start, as do the tokens, so the local part
    // of the counter is share × peak, not share × (peak − first): T / (s·u) of plan §3.2.1.
    const factor = (100 / share) * (span / candidate.peak_percent);
    candidate = {
      ...candidate,
      tokens: scalePartial(candidate.tokens, factor),
      slices: candidate.slices?.map((slice) => ({ ...slice, tokens: scalePartial(slice.tokens, factor) })),
    };
  }
  const tokenSource =
    candidate.slices && candidate.slices.length > 0
      ? sumPartial(candidate.slices.map((s) => s.tokens))
      : candidate.tokens;
  const tokens = normalizeVector(tokenSource, span);
  const day = candidate.start_ts.slice(0, 10);
  const { rates, bySlice } = resolveRates(candidate, card, groupId, day, candidate.slices, tokenSource);
  const valued =
    candidate.slices && candidate.slices.length > 0
      ? valueFromSlices(span, bySlice)
      : valueVector(tokens, rates);
  return {
    sample: {
      window_id: candidate.window_id,
      start_ts: candidate.start_ts,
      end_ts: candidate.end_ts,
      cadence_hours: candidate.cadence_hours,
      tokens_per_1pct: tokens,
      api_usd_per_1pct: valued.usd,
      api_by_type: valued.byType,
      quality,
      span_percent: span,
    },
    diagnostic: {
      window_id: candidate.window_id,
      accepted: true,
      reason: quality.reason,
      quality,
      start_ts: candidate.start_ts,
      end_ts: candidate.end_ts,
      ...(share !== undefined ? { local_share_percent: share } : {}),
    },
  };
}
