import type { SubjectCost, SubscriptionSpend } from "../../lib/api";
import { modelColors, vendorColor } from "../../lib/model-colors";
import { vendorName } from "../../lib/progress";

/** One part of a project's priced traffic: its tokens and API value with their shares of the whole. */
export interface ShareRow {
  key: string;
  label: string;
  color: string;
  tokens: number;
  tokenShare: number;
  apiUsd: number;
  apiShare: number;
  /** Cost from subscriptions; null when no part of it is known (providers only). */
  billedUsd?: number | null;
  billedShare?: number | null;
  /** Some subscription of the part has an unknown or partial cost. */
  billedIncomplete?: boolean;
}

export interface ProjectShares {
  providers: ShareRow[];
  /** Null when the report carries no model split (an older server). */
  models: ShareRow[] | null;
  tokens: number;
  apiUsd: number;
  billedUsd: number | null;
}

const share = (part: number, whole: number) => whole > 0 ? (part / whole) * 100 : 0;
// A ring stays readable up to six parts (five models and the rest).
const MODEL_LIMIT = 6;

/** Provider and model shares of a subject's priced traffic, largest API value first. */
export function projectShares(subject: SubjectCost, spends: readonly SubscriptionSpend[], otherLabel: (count: number) => string): ProjectShares {
  const vendorOf = new Map(spends.map(spend => [spend.id.toLowerCase(), spend.vendor]));
  const byVendor = new Map<string, { tokens: number; apiUsd: number; billedUsd: number; billedKnown: boolean; billedIncomplete: boolean }>();
  for (const [subId, slice] of Object.entries(subject.subscriptions)) {
    const vendor = vendorOf.get(subId.toLowerCase()) || "?";
    const sum = byVendor.get(vendor) ?? { tokens: 0, apiUsd: 0, billedUsd: 0, billedKnown: false, billedIncomplete: false };
    sum.tokens += slice.tokens;
    sum.apiUsd += slice.api_usd;
    if (slice.billed_usd != null) { sum.billedUsd += slice.billed_usd; sum.billedKnown = true; }
    if (slice.billed_usd == null || slice.billed_complete === false) sum.billedIncomplete = true;
    byVendor.set(vendor, sum);
  }
  const tokens = [...byVendor.values()].reduce((acc, sum) => acc + sum.tokens, 0);
  const apiUsd = [...byVendor.values()].reduce((acc, sum) => acc + sum.apiUsd, 0);
  const billedParts = [...byVendor.values()].filter(sum => sum.billedKnown);
  const billedUsd = billedParts.length ? billedParts.reduce((acc, sum) => acc + sum.billedUsd, 0) : null;
  const providers = [...byVendor].map(([vendor, sum]): ShareRow => ({
    key: vendor,
    label: vendorName(vendor),
    color: vendorColor(vendor) ?? "var(--muted)",
    tokens: sum.tokens,
    tokenShare: share(sum.tokens, tokens),
    apiUsd: sum.apiUsd,
    apiShare: share(sum.apiUsd, apiUsd),
    billedUsd: sum.billedKnown ? sum.billedUsd : null,
    billedShare: sum.billedKnown && billedUsd != null ? share(sum.billedUsd, billedUsd) : null,
    billedIncomplete: sum.billedIncomplete,
  })).sort((a, b) => b.apiUsd - a.apiUsd || b.tokens - a.tokens);
  return { providers, models: subject.models ? modelRows(subject.models, otherLabel) : null, tokens, apiUsd, billedUsd };
}

function modelRows(models: NonNullable<SubjectCost["models"]>, otherLabel: (count: number) => string): ShareRow[] {
  const sorted = Object.entries(models).filter(([, slice]) => slice.tokens > 0 || slice.api_usd > 0)
    .sort(([a, x], [b, y]) => y.api_usd - x.api_usd || y.tokens - x.tokens || a.localeCompare(b));
  const tokens = sorted.reduce((acc, [, slice]) => acc + slice.tokens, 0);
  const apiUsd = sorted.reduce((acc, [, slice]) => acc + slice.api_usd, 0);
  // A long tail folds into one row so the ring keeps readable parts.
  const head = sorted.length > MODEL_LIMIT ? sorted.slice(0, MODEL_LIMIT - 1) : sorted;
  const tail = sorted.slice(head.length);
  const fills = modelColors(head.map(([model]) => model));
  const rows = head.map(([model, slice], index): ShareRow => ({
    key: model, label: model, color: fills[index]!, tokens: slice.tokens, tokenShare: share(slice.tokens, tokens),
    apiUsd: slice.api_usd, apiShare: share(slice.api_usd, apiUsd),
  }));
  if (tail.length) {
    const restTokens = tail.reduce((acc, [, slice]) => acc + slice.tokens, 0), restUsd = tail.reduce((acc, [, slice]) => acc + slice.api_usd, 0);
    rows.push({ key: "", label: otherLabel(tail.length), color: "var(--faint)", tokens: restTokens, tokenShare: share(restTokens, tokens),
      apiUsd: restUsd, apiShare: share(restUsd, apiUsd) });
  }
  return rows;
}
