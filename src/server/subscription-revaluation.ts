import type { WindowUsage } from "../shared/codex-accounting";

/** The paired cohort is independent of provider credit conversion availability. */
export function addReferenceValuation(usage: WindowUsage, historical: number | null, reference: number | null): void {
  const hasReference = reference !== null && Number.isFinite(reference) && reference >= 0;
  const paired = hasReference && historical !== null && Number.isFinite(historical) && historical >= 0;
  usage.reference_api_standard = hasReference ? reference : 0;
  usage.reference_priced_tokens = hasReference ? usage.tokens : 0;
  usage.reference_unpriced_events = hasReference ? 0 : usage.events;
  usage.paired_historical_api = paired ? historical : 0;
  usage.paired_reference_api = paired ? reference : 0;
  usage.revaluation_events = paired ? usage.events : 0;
  usage.revaluation_tokens = paired ? usage.tokens : 0;
}
