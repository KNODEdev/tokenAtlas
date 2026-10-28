import { useState } from "react";

export type TableSortValue = string | number | null | undefined;
export type TableSort = { column: string; direction: "asc" | "desc" };
export type TableSorting = { sort: TableSort | null; columns: readonly string[]; onSort: (sort: TableSort) => void };
const decimalSeparators = new Map<string, string>();

export function compareTableValues(a: TableSortValue, b: TableSortValue, sort: TableSort, collator: Intl.Collator): number {
  const missing = (value: TableSortValue) => value == null || value === "" || (typeof value === "number" && !Number.isFinite(value));
  if (missing(a) || missing(b)) return Number(missing(a)) - Number(missing(b));
  const result = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return sort.direction === "asc" ? result : -result;
}

/** Explicit raw values take precedence; this fallback handles the shared display formatters. */
export function displayedTableValue(text: string, locale: string): TableSortValue {
  text = text.trim();
  if (!text || /^(?:—|–|-|…|no rate|brak stawki|unknown|nieznane|not applicable|nie dotyczy|no data|brak danych)$/i.test(text)) return null;
  let decimal = decimalSeparators.get(locale);
  if (!decimal) {
    decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
    decimalSeparators.set(locale, decimal);
  }
  const normalized = text.replace(/[\s\u00a0\u202f]/g, "").replace(/^[≈≥≤<>]/, "").replace(/^[$€£]/, "").replace(/−/g, "-");
  const duration = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(normalized);
  if (duration && duration.slice(1).some(Boolean)) return Number(duration[1] ?? 0) * 86400 + Number(duration[2] ?? 0) * 3600 + Number(duration[3] ?? 0) * 60;
  const numeric = normalized.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
  const match = /^([+-]?\d+(?:\.\d+)?)([kMB])?(%|USD|EUR|PLN|ms|s|tok\/s)?$/.exec(numeric);
  if (!match) return text;
  return Number(match[1]) * ({ k: 1e3, M: 1e6, B: 1e9 }[match[2] ?? ""] ?? 1) * (match[3] === "ms" ? 0.001 : 1);
}

/** Version order, not a guessed release date; dated snapshots stay within their model version. */
export function modelVersionSortValue(model: string | null): string | null {
  if (!model || model === "?") return null;
  const version = /(?:^|[^\d])(\d{1,3})(?:[.-](\d{1,2})(?!\d))?(?:[.-](\d{1,2})(?!\d))?/.exec(model);
  return `${[version?.[1], version?.[2], version?.[3]].map(part => (part ?? "0").padStart(3, "0")).join(".")} ${model}`;
}

/** Sort the complete result before the caller paginates it. */
export function useTableSort<T>(rows: readonly T[], values: Record<string, (row: T) => TableSortValue>, locale: string, initial: TableSort,
  onChange?: () => void) {
  const [sort, setSort] = useState<TableSort>(initial);
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const value = values[sort.column];
  const sorted = value ? [...rows].sort((a, b) => compareTableValues(value(a), value(b), sort, collator)) : rows;
  const sorting: TableSorting = { sort, columns: Object.keys(values), onSort: next => { setSort(next); onChange?.(); } };
  return { rows: sorted, sorting };
}
