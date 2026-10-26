import { resolvePlanVersion } from "./plans-catalog";
import { round4 } from "./capacity-equivalents";
import type { BuildPlanCapacityInput, PlanCapacityResult, PlanCapacityAbsentReason, SampleDiagnostic, CohortIdentity, AdmittedSample, LocalCalibration, PrimaryEstimate } from "./plan-capacity-contracts";
import { referenceView, emptyLocal, emptyPrimary, derivedFrom, explanationOf, valueReference, profileShares, deviationOf } from "./plan-capacity-estimates";
import type { Candidate } from "./plan-capacity-candidates";
import { candidatesForTarget, dedupe, admit } from "./plan-capacity-candidates";
import { cohortSpread, spanHoursOf, cadencePolicy, medianTokenVector, statusOf, medianApi, relativeDeviation, apiStatusOf } from "./plan-capacity-statistics";
import { emptyTokens, allFivePresent, absent, presentTokens } from "./plan-capacity-quantities";
import { CONSISTENCY_RELATIVE_MAX } from "./plan-capacity-contracts";

export function buildPlanCapacity(input: BuildPlanCapacityInput): PlanCapacityResult {
  const asOf = input.as_of;
  const ref = referenceView(input.catalog, input.provider, input.plan_id, asOf);
  const resolved = resolvePlanVersion(input.catalog, input.provider, input.plan_id, asOf);
  if (resolved.kind === "unassigned" || resolved.kind === "no_version_for_day") {
    const reason: PlanCapacityAbsentReason =
      resolved.kind === "no_version_for_day"
        ? "no_version_for_day"
        : resolved.reason === "unknown_plan"
          ? "unknown_plan"
          : "unknown_provider";
    const diagnostics: SampleDiagnostic[] = [];
    const local = emptyLocal(diagnostics, `version unresolved: ${reason}`);
    const primary = emptyPrimary(reason);
    return {
      cohort: null,
      as_of: asOf,
      local_calibration: local,
      default_reference: ref,
      primary,
      deviation: { local_vs_reference: null, reason },
      derived: derivedFrom(primary, { usd_per_month: null, cadence_hours: null, current_used_percent: input.current_used_percent }),
    };
  }
  const cohort: CohortIdentity = {
    provider_group: resolved.group.id,
    plan_id: resolved.plan.plan_id,
    plan_version: resolved.version_id,
    version_from: resolved.version_from,
    window_kind: input.window_kind,
  };
  const rawCandidates: Candidate[] = [];
  const diagnostics: SampleDiagnostic[] = [];
  for (const obs of input.observations) {
    const { candidates, diagnostic } = candidatesForTarget(
      input.catalog,
      obs,
      cohort.provider_group,
      cohort.plan_id,
      cohort.plan_version,
      input.window_kind
    );
    if (diagnostic) diagnostics.push(diagnostic);
    rawCandidates.push(...candidates);
  }
  const { kept, rejected } = dedupe(rawCandidates);
  diagnostics.push(...rejected);
  const samples: AdmittedSample[] = [];
  for (const c of kept) {
    const { sample, diagnostic } = admit(c, input.rateCard, cohort.provider_group);
    diagnostics.push(diagnostic);
    if (sample) samples.push(sample);
  }
  samples.sort((a, b) => a.start_ts.localeCompare(b.start_ts) || a.window_id.localeCompare(b.window_id));
  diagnostics.sort(
    (a, b) =>
      a.start_ts.localeCompare(b.start_ts) ||
      a.window_id.localeCompare(b.window_id) ||
      a.reason.localeCompare(b.reason)
  );
  const spread = cohortSpread(samples);
  const spanHours = spanHoursOf(samples);
  const cadence = cadencePolicy(samples);
  const tokenVector = samples.length === 0 ? emptyTokens("no_accepted_windows") : medianTokenVector(samples);
  const tokenStatus = statusOf({
    accepted: samples.length,
    spanHours,
    cadenceHours: cadence.cadenceHours,
    consistent: spread.consistent,
    mixedCadence: cadence.mixed,
    completeVector: samples.length === 0 ? false : allFivePresent(tokenVector),
  });
  const apiAgg = samples.length === 0 ? { usd: absent("no_accepted_windows"), byType: emptyTokens("no_accepted_windows") } : medianApi(samples);
  const valuedUsd: number[] = [];
  for (const s of samples) {
    if (s.api_usd_per_1pct.absent == null) valuedUsd.push(s.api_usd_per_1pct.value);
  }
  const usdSpread = relativeDeviation(valuedUsd);
  const usdConsistent = usdSpread != null && usdSpread <= CONSISTENCY_RELATIVE_MAX;
  const apiStatus =
    apiAgg.usd.absent != null
      ? { status: "none" as const, reason: apiAgg.usd.absent }
      : apiStatusOf(tokenStatus.status, valuedUsd.length, samples.length, usdConsistent || valuedUsd.length < 2);
  const local: LocalCalibration = {
    tokens: {
      status: tokenStatus.status,
      reason: tokenStatus.reason,
      vector: tokenVector,
      spread: spread.spread != null && Number.isFinite(spread.spread) ? round4(spread.spread) : spread.spread,
      consistent: spread.consistent,
    },
    api: {
      status: apiStatus.status,
      reason: apiStatus.reason,
      usd_per_1pct: apiAgg.usd,
      by_type: apiAgg.byType,
    },
    samples: {
      accepted: samples.length,
      rejected: diagnostics.filter((d) => !d.accepted).length,
      independent_windows: samples.length,
      span_hours: spanHours != null ? round4(spanHours) : null,
      cadence_hours: cadence.cadenceHours,
      diagnostics,
    },
    explanation: "",
  };
  local.explanation = explanationOf(local);
  if (cohort.provider_group === "openai") local.explanation += " Ekwiwalent Standard: tokeny i USD referencyjne ważone mnożnikiem kredytów Speed. Surowe tokeny bez zmian. To kalibracja lokalna; niezależna weryfikacja w statystykach Speed.";
  const sampleRates = samples.find((s) => s.api_usd_per_1pct.absent == null)
    ? null
    : kept[0]?.rates ?? null;
  const refUsd = valueReference(ref, input.rateCard, cohort.provider_group, asOf, sampleRates ?? kept[0]?.rates ?? null);
  let primary: PrimaryEstimate;
  if (local.tokens.status === "reliable") {
    primary = {
      source: "local_calibration",
      tokens_per_1pct: local.tokens.vector,
      api_usd_per_1pct: local.api.usd_per_1pct,
      token_profile: profileShares(local.tokens.vector),
      provenance: {
        capacity: "measured",
        price: local.api.usd_per_1pct.absent == null ? "rate-card" : "none",
        source: "local_calibration",
      },
    };
  } else if (ref.present && ref.tokens_per_1pct) {
    const tokens = presentTokens(ref.tokens_per_1pct);
    primary = {
      source: "default_reference",
      tokens_per_1pct: tokens,
      api_usd_per_1pct: refUsd,
      token_profile: profileShares(tokens),
      provenance: {
        capacity: "single",
        price: refUsd.absent == null ? "rate-card" : "none",
        source: "default_reference",
      },
    };
  } else {
    primary = emptyPrimary(ref.reason === "no_version_for_day" ? "no_version_for_day" : "no_reference");
  }
  return {
    cohort,
    as_of: asOf,
    normalization: cohort.provider_group === "openai" ? "standard" : undefined,
    local_calibration: local,
    default_reference: ref,
    primary,
    deviation: deviationOf(local.tokens.vector, ref.tokens_per_1pct),
    derived: derivedFrom(primary, {
      usd_per_month: resolved.version.usd_per_month,
      cadence_hours: cadence.cadenceHours,
      current_used_percent: input.current_used_percent,
    }),
  };
}

export { CONSISTENCY_RELATIVE_MAX, PLAN_CAPACITY_ABSENT_REASONS } from "./plan-capacity-contracts";
export type { CalibrationStatus, PrimarySource, PlanCapacityAbsentReason, Quantity, TokenQuantities, TokenRates, ObservationSlice, ObservationPart, PlanWindowObservation, SampleDiagnostic, CohortIdentity, LocalTokens, LocalApi, LocalCalibration, DefaultReferenceView, PrimaryEstimate, DerivedPlanMetrics, PlanCapacityResult, BuildPlanCapacityInput, PlanCapacityCollectContext } from "./plan-capacity-contracts";
export { ratesFromCard } from "./plan-capacity-pricing";
export { resetIntervalKey } from "./plan-capacity-candidates";
export { collectPlanWindowObservations } from "./plan-capacity-observations";
