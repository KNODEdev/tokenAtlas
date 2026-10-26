import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CycleBreakdownResponse } from "../lib/api";
import type { CodexWindowModelRow } from "../../shared/codex-window-detail";
import type { WindowModelUsage } from "../../shared/window-model-usage";
import { setLanguage } from "../lib/i18n";
import { tableColumnsKey } from "../lib/table-columns";
import { freshWindowInput, sumWindowTokens, totalWindowTokens } from "../lib/window-tokens";
import { ClaudeWindowModels } from "./ClaudeWindowModels";
import { CodexWindowModels } from "./CodexWindowModels";
import { WindowModelTable } from "./WindowModelTable";

afterEach(() => setLanguage("en"));
const model: WindowModelUsage = { model: "fixture-model", calls: 2, input: 1_000, cached: 400,
  cache_write: 50, output: 300, reasoning: 80, api_standard: 1.4, unpriced_tokens: 0 };
const cells = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))]
  .map(match => match[1]!.replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").replaceAll("▥", ""));
const bodyRows = (html: string) => [...html.split("<tbody>")[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => cells(match[1]!, "td"));

test("Claude and Codex have the same headers, definitions and input arithmetic in both languages", () => {
  const row = { ...model, cache_write_complete: true, speed: "standard", api: { total: 1.4 }, credits: null } as unknown as CodexWindowModelRow;
  const data = { model_detail: { rows: [row], excluded_mirror_events: 0, excluded_counter_events: 0, invalid_token_events: 0 } } as CycleBreakdownResponse;
  for (const language of ["en", "pl"] as const) {
    setLanguage(language);
    const claude = renderToStaticMarkup(<ClaudeWindowModels rows={[model]} />);
    const codex = renderToStaticMarkup(<CodexWindowModels data={data} loading={false} error={null} cycleLabel="fixture" />);
    expect(cells(claude, "th")).toEqual(cells(codex, "th"));
    expect(cells(claude, "th")).toHaveLength(12);
    const claudeCells = bodyRows(claude)[0]!, codexCells = bodyRows(codex)[0]!;
    expect(claudeCells.slice(1, 11)).toEqual(codexCells.slice(1, 11));
    expect(claudeCells.slice(3, 9)).toEqual(language === "en"
      ? ["1,000", "550", "400", "50", "40%", "300"] : ["1000", "550", "400", "50", "40%", "300"]);
    expect(claude).toContain(language === "en" ? "not applicable" : "nie dotyczy");
    expect(claude).not.toContain(language === "en" ? "no rate" : "brak stawki");
  }
});

test("totals weight cache by input and prices by priced tokens while retaining unpriced quantities", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<ClaudeWindowModels rows={[model, { ...model, model: "unpriced", input: 100,
    cached: 0, cache_write: 0, output: 100, reasoning: 0, api_standard: 0, unpriced_tokens: 200 }]} />);
  const total = bodyRows(html).at(-1)!;
  expect(total.slice(1, 10)).toEqual(["4", "1,500", "1,100", "650", "400", "50", "36.4%", "400", "≥ $1.40"]);
  expect(total[10]).toBe("$1,076.92");
  expect(html).toContain("no rate");
  const counts = sumWindowTokens([model]);
  expect(freshWindowInput(counts)).toBe(550);
  expect(totalWindowTokens(counts)).toBe(1_300);
});

test("selected columns reorder the actual values, including cells after the input split", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === tableColumnsKey("fixture")
      ? JSON.stringify({ order: ["c4", "input", "fresh", "cached", "c0"], hidden: ["c1", "c2", "cache-write", "c3", "c5", "c6", "c7"] }) : null,
  } });
  try {
    const html = renderToStaticMarkup(<WindowModelTable tableId="fixture" rows={[{ ...model, model: "fixture-model", api: null }]} />);
    expect(cells(html, "th")).toEqual(["Output", "In total", "Fresh In", "Cache read", "Model"]);
    expect(bodyRows(html)[0]).toEqual(["300", "1,000", "550", "400", "fixture-model"]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("older stored Claude answers do not invent a zero token breakdown", () => {
  const html = renderToStaticMarkup(<ClaudeWindowModels rows={undefined} />);
  expect(html).toContain("not prepared yet");
  expect(html).not.toContain("<table");
});

test("Codex missing write evidence stays unknown in old answers, model sums and totals", () => {
  for (const language of ["en", "pl"] as const) {
    setLanguage(language);
    const base = { ...model, speed: "standard", api: { total: 1.4 }, credits: null } as unknown as CodexWindowModelRow;
    const rows = [
      { ...base, model: "missing", cache_write: 0 },
      { ...base, model: "mixed", cache_write: 50, cache_write_complete: true },
      { ...base, model: "mixed", cache_write: 0, cache_write_complete: false },
      { ...base, model: "reported-zero", cache_write: 0, cache_write_complete: true },
    ];
    const data = { model_detail: { rows } } as CycleBreakdownResponse;
    const html = renderToStaticMarkup(<CodexWindowModels data={data} loading={false} error={null} cycleLabel="fixture" />);
    const rendered = bodyRows(html);
    const missing = rendered.find(row => row[0]!.includes("missing"))!;
    const mixed = rendered.find(row => row[0]!.includes("mixed"))!;
    const zero = rendered.find(row => row[0]!.includes("reported-zero"))!;
    expect(missing[6]).toBe("—");
    expect(missing[4]).toBe("—");
    expect(mixed[6]).toBe("≥ 50");
    expect(zero[6]).toBe("0");
    expect(rendered.at(-1)![6]).toBe("≥ 50");
    expect(rendered.at(-1)![2]).toBe(language === "en" ? "5,200" : "5200");
  }
});
