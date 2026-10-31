import { describe, expect, test } from "bun:test";
import type { AllowanceCandidate } from "../../shared/allowance-summary";
import { allowanceDefaults, allowanceRange, cyclesText, ratioText, ratioTone, readAllowanceChoice, writeAllowanceChoice } from "./allowance-summary-view";

const candidate = (account: string, provider: string, usd: number | null, recent: number): AllowanceCandidate =>
  ({ provider, account, counter: "weekly", counter_label: "Weekly", state: "current", plan: "pro", plan_label: "Pro", usd_per_month: usd, recent_cycles: recent });

describe("allowance summary defaults", () => {
  const list = [candidate("codex2", "codex", 200, 2), candidate("codex1", "codex", 200, 5), candidate("claude1", "claude", 200, 3),
    candidate("plus", "codex", 20, 9), candidate("mystery", "claude", null, 9), candidate("idle", "claude", 500, 0)];
  test("A is the dearest active plan (ties by recent cycles), B another provider's at the same price", () => {
    expect(allowanceDefaults(list, { a: null, b: null })).toEqual({ a: "codex1", b: "claude1" });
  });
  test("an unknown price or no recent cycle is never a default, and no same-price peer leaves B empty", () => {
    expect(allowanceDefaults([candidate("plus", "codex", 20, 9), candidate("mystery", "claude", null, 9)], { a: null, b: null }))
      .toEqual({ a: "plus", b: null });
  });
  test("a remembered side is kept, an emptied B stays empty, and a vanished one falls back", () => {
    expect(allowanceDefaults(list, { a: "mystery", b: "plus" })).toEqual({ a: "mystery", b: "plus" });
    expect(allowanceDefaults(list, { a: "codex1", b: "" })).toEqual({ a: "codex1", b: null });
    expect(allowanceDefaults(list, { a: "gone", b: "gone-too" })).toEqual({ a: "codex1", b: "claude1" });
  });
});

describe("allowance summary range and marks", () => {
  test("months count back from the current calendar month in UTC", () => {
    expect(allowanceRange(3, Date.parse("2026-10-30T12:00:00Z"))).toEqual({ since: "2026-08-01", until: "2026-10-30" });
    expect(allowanceRange(12, Date.parse("2026-01-05T00:00:00Z"))).toEqual({ since: "2025-02-01", until: "2026-01-05" });
  });
  test("a ratio carries its bound or approximation and is coloured only when exact or bounded", () => {
    expect(ratioText({ ratio: 2.2427, relation: "≤", approximate: false }, "en")).toBe("≤ 2.24×");
    expect(ratioText({ ratio: 2.2427, relation: null, approximate: true }, "pl")).toBe("≈ 2,24×");
    expect(ratioText({ ratio: null, relation: null, approximate: false }, "en")).toBe("");
    expect(ratioTone({ ratio: 2.24, approximate: true })).toBe("var(--muted)");
    expect(ratioTone({ ratio: 2.24, approximate: false })).toBe("var(--crit)");
    expect(ratioTone({ ratio: 1.07, approximate: false })).toBe("var(--accent)");
    expect(ratioTone({ ratio: 0.5, approximate: false })).toBe("var(--crit)");
  });
  test("the remembered choice survives a reload and a broken store reads as the default", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) } as unknown as Storage;
    writeAllowanceChoice({ a: "codex1", b: "", months: 6, unit: "tokens" }, storage);
    expect(readAllowanceChoice(storage)).toEqual({ a: "codex1", b: "", months: 6, unit: "tokens" });
    store.set("tokenatlas.allowance-summary.v1", "{not json");
    expect(readAllowanceChoice(storage)).toMatchObject({ a: null, months: 3, unit: "api_standard" });
  });
});

test("cycle counts read naturally in both languages", () => {
  const en = (text: string, _pl: string, values: Array<string | number> = []) => text.replace("{0}", String(values[0]));
  const pl = (_en: string, text: string) => text;
  expect([1, 2, 5].map(n => cyclesText(n, en))).toEqual(["1 cycle", "2 cycles", "5 cycles"]);
  expect([1, 2, 4, 5, 12, 22, 25].map(n => cyclesText(n, pl))).toEqual(["1 cykl", "2 cykle", "4 cykle", "5 cykli", "12 cykli", "22 cykle", "25 cykli"]);
});
