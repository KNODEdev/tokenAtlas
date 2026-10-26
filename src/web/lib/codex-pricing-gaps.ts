import type { CodexAccountingReport, CodexBillingBasis, CodexSpeed } from "../../shared/codex-accounting";

export interface CodexPricingGap {
  model: string; basis: CodexBillingBasis; speed: CodexSpeed;
  since: string; until: string; days: number; events: number; tokens: number;
}

/** Missing prices are derived from unpriced requests, never from idle calendar days. */
export function codexPricingGaps(report: Pick<CodexAccountingReport, "breakdown">): CodexPricingGap[] {
  const daily = new Map<string, CodexPricingGap>();
  for (const row of report.breakdown) {
    if (!row.model) continue;
    for (const basis of ["api_equivalent_usd", "chatgpt_credits"] as const) {
      const candidates = new Map<CodexSpeed, typeof row.amounts[CodexBillingBasis]>();
      candidates.set("standard", basis === "api_equivalent_usd" ? row.normalization.standard_api_usd : row.normalization.standard_credits);
      if (row.speed === "standard" || row.speed === "fast") candidates.set(row.speed, row.amounts[basis]);
      for (const [speed, coverage] of candidates) {
        const missing = coverage.reasons.missing_rate;
        if (!missing?.events) continue;
        const key = JSON.stringify([row.model, basis, speed, row.day]);
        const previous = daily.get(key);
        daily.set(key, { model: row.model, basis, speed, since: row.day, until: row.day, days: 1,
          events: (previous?.events ?? 0) + missing.events, tokens: (previous?.tokens ?? 0) + missing.tokens });
      }
    }
  }
  const result: CodexPricingGap[] = [];
  const sorted = [...daily.values()].sort((a, b) => a.model.localeCompare(b.model) || a.basis.localeCompare(b.basis) || a.speed.localeCompare(b.speed) || a.since.localeCompare(b.since));
  for (const row of sorted) {
    const previous = result.at(-1);
    if (previous && previous.model === row.model && previous.basis === row.basis && previous.speed === row.speed
      && Date.parse(row.since) - Date.parse(previous.until) === 86400000) {
      previous.until = row.until; previous.days++; previous.events += row.events; previous.tokens += row.tokens;
    } else result.push({ ...row });
  }
  return result;
}
