import { usd as fmtUsd } from "../../lib/format";
import { translate } from "../../lib/i18n";
import { vendorShade } from "../../lib/model-colors";

export function colorOf(id: string, vendor: string, codexSeen: number): string {
  if (vendor === "codex") return vendorShade("var(--codex)", codexSeen);
  if (vendor === "claude") return "var(--claude)";
  if (vendor === "grok") return "var(--grok)";
  if (vendor === "opencode") return "var(--glm)";
  if (vendor === "gemini") return vendorShade("var(--gemini)", id === "main" ? 0 : 1);
  return "var(--faint)";
}
const MONTHS = [
  ["Jan", "sty"],
  ["Feb", "lut"],
  ["Mar", "mar"],
  ["Apr", "kwi"],
  ["May", "maj"],
  ["Jun", "cze"],
  ["Jul", "lip"],
  ["Aug", "sie"],
  ["Sep", "wrz"],
  ["Oct", "paź"],
  ["Nov", "lis"],
  ["Dec", "gru"],
] as const;
export function bucketLabel(bucket: string, group: string): string {
  const parts = bucket.split("-");
  const month = MONTHS[Number(parts[1]) - 1];
  const m = month ? translate(month[0], month[1]) : parts[1] ?? "";
  return group === "month" ? `${m} ${parts[0]}` : `${Number(parts[2])} ${m}`;
}
export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}
export interface Tinted {
  id: string;
  label: string;
  vendor: string;
  color: string;
  tokens: number;
  calls: number;
  usd: number | null;
  priced_usd?: number;
  first_ts: string | null;
  last_ts: string | null;
}
export type Priced = { usd: number | null; priced_usd?: number };
/**
 * API-eq of a sum with unpriced events: its priced part is a lower bound, not a missing value.
 * A bound of zero says nothing (e.g. conflicts only), so it stays "—".
 */
export function apiEq(s: Priced, value: number | null = s.usd ?? s.priced_usd ?? null): string {
  return lowerBound(value, s.usd === null ? "≥ " : "", fmtUsd);
}
export function lowerBound(value: number | null, prefix: string, format: (v: number) => string): string {
  return value === null || (prefix && value === 0) ? "—" : prefix + format(value);
}
