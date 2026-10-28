import { expect, test } from "bun:test";
import { compareTableValues, displayedTableValue, modelVersionSortValue } from "./table-sort";

test("sorting retains exact numbers and puts missing data last in either direction", () => {
  const collator = new Intl.Collator("pl-PL", { numeric: true });
  const values = [null, 1200.02, NaN, 1200.01, undefined, 0];
  for (const direction of ["asc", "desc"] as const) {
    const sorted = [...values].sort((a, b) => compareTableValues(a, b, { column: "value", direction }, collator));
    expect(sorted.slice(0, 3)).toEqual(direction === "asc" ? [0, 1200.01, 1200.02] : [1200.02, 1200.01, 0]);
    expect(sorted.slice(3).every(value => value == null || Number.isNaN(value))).toBe(true);
  }
});

test("shared display formats sort numerically in English and Polish", () => {
  expect(displayedTableValue("1,2M", "pl-PL")).toBe(1_200_000);
  expect(displayedTableValue("$1,234.50", "en-US")).toBe(1234.5);
  expect(displayedTableValue("≥ $1 234,50", "pl-PL")).toBe(1234.5);
  expect(displayedTableValue("99.5%", "en-US")).toBe(99.5);
  expect(displayedTableValue("—", "pl-PL")).toBeNull();
  expect(displayedTableValue("2026-10-28", "pl-PL")).toBe("2026-10-28");
  expect(displayedTableValue("500 ms", "en-US")).toBe(0.5);
  expect(displayedTableValue("2 s", "en-US")).toBe(2);
  expect(displayedTableValue("1h 03m", "en-US")).toBe(3780);
  expect(displayedTableValue("2d 04h", "en-US")).toBe(187200);
});

test("model defaults compare numeric versions across families without promoting dated snapshots", () => {
  const collator = new Intl.Collator("en-US", { numeric: true });
  const sort = (models: (string | null)[]) => [...models].sort((a, b) => compareTableValues(modelVersionSortValue(a), modelVersionSortValue(b), { column: "model", direction: "desc" }, collator));
  expect(sort(["gpt-5.6-sol", null, "gpt-6-astra", "gpt-6.1-sol", "gpt-5.10-sol"])).toEqual([
    "gpt-6.1-sol", "gpt-6-astra", "gpt-5.10-sol", "gpt-5.6-sol", null,
  ]);
  expect(sort(["claude-opus-4-1-20250805", "claude-fable-4-5", "claude-opus-4-6"])).toEqual([
    "claude-opus-4-6", "claude-fable-4-5", "claude-opus-4-1-20250805",
  ]);
});
