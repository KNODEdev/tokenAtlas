import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { expect, spyOn, test } from "bun:test";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import { SubscriptionModelDetailBody, SubscriptionModelDetails } from "./SubscriptionModelDetails";
import { saveTableColumns } from "../lib/table-columns";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

const baseQuantities = {
  in_uncached: 100,
  in_cache_read: 40,
  in_cache_write_5m: 5,
  in_cache_write_1h: 0,
  in_cache_write_unknown: 0,
  out_total: 30,
  out_thinking: 8,
};
const baseRates = {
  in_uncached: 2,
  in_cache_read: 0.5,
  in_cache_write_5m: 3,
  in_cache_write_1h: 4,
  in_cache_write_unknown: 5,
  out_total: 8,
  out_thinking: null,
};
const baseCosts = {
  in_uncached: 0.0002,
  in_cache_read: 0.00002,
  in_cache_write_5m: 0.000015,
  in_cache_write_1h: 0,
  in_cache_write_unknown: 0,
  out_total: 0.00024,
  out_thinking: null,
};

function row(overrides: Partial<SubscriptionModelDetail> = {}): SubscriptionModelDetail {
  return {
    day: "2026-09-11",
    model: "gpt-6-astra",
    speed: "standard",
    source: "workstation-a",
    calls: 2,
    tokens: 170,
    quantities: { ...baseQuantities },
    rates: { ...baseRates },
    costs: { ...baseCosts },
    api_standard: 1.1,
    api_actual: 1.23,
    pricing_source: "https://example.test/pricing",
    pricing_note: "Dated actual rate",
    ...overrides,
  };
}

async function render(rows: SubscriptionModelDetail[], openDataSettings?: (target: DataSettingsTarget) => void) {
  setLanguage("en");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  await act(async () => { root.render(<SubscriptionModelDetails rows={rows} account="codex1" openDataSettings={openDataSettings} />); });
  return { ...dom, root };
}

async function cleanup(rendered: Awaited<ReturnType<typeof render>>): Promise<void> {
  await act(async () => rendered.root.unmount());
  rendered.restore();
}

test("unknown mode directs repair to source history rather than rate editing", async () => {
  let target: DataSettingsTarget | undefined;
  const rendered = await render([row({ speed: "unknown", api_actual: null, pricing_issue: "unknown_mode" })], value => { target = value; });
  try {
    expect(rendered.host.textContent).toContain("mode not recorded");
    expect(rendered.host.textContent).not.toContain("Edit rates");
    const button = nodes(rendered.host).find(node => node.tagName === "BUTTON" && node.textContent === "Inspect source data")!;
    await invoke(button, "onClick");
    expect(target?.area).toBe("data"); expect(target?.model).toBe("gpt-6-astra");
  } finally { await cleanup(rendered); }
});

test("renders bucket quantities and actual details, keeps partial totals explicit, and prefills rate repair", async () => {
  const missing = row({
    day: "2026-09-12",
    model: "gpt-5.6-luna",
    speed: "unknown",
    source: "workstation-b",
    calls: 1,
    tokens: 50,
    quantities: { ...baseQuantities, in_uncached: 20, in_cache_read: 0, in_cache_write_5m: 0, out_total: 30, out_thinking: 6 },
    rates: { ...baseRates, in_uncached: null, out_total: null },
    costs: { ...baseCosts, in_uncached: null, out_total: null },
    api_standard: 0.4,
    api_actual: null,
  });
  let target: DataSettingsTarget | undefined;
  const rendered = await render([row(), missing], value => { target = value; });
  try {
    expect(rendered.host.textContent).toContain("Cache write 5m");
    expect(rendered.host.textContent).toContain("Reasoning subset");
    const body = renderToStaticMarkup(<SubscriptionModelDetailBody row={row()} account="codex1" />);
    expect(body).toContain("Actual pricing");
    expect(body).toContain("quantity × rate / 1M = cost");
    expect(body).toContain("Dated actual rate");
    expect(rendered.host.textContent).toContain("missing rates");
    expect(rendered.host.textContent).toContain("≥ $1.23");
    expect(rendered.host.textContent).not.toContain("Actual total$0.00");

    const edit = nodes(rendered.host).find(node => node.tagName === "BUTTON" && node.textContent === "Edit rates");
    if (!edit) throw new Error("Edit rates button not found");
    await invoke(edit, "onClick");
    expect(target).toMatchObject({
      area: "rates",
      account: "codex1",
      since: "2026-09-12",
      until: "2026-09-12",
      model: "gpt-5.6-luna",
      basis: "api_equivalent_usd",
    });
  } finally {
    await cleanup(rendered);
  }
});

test("paginates at fifty rows while retaining the all-row total", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => row({
    day: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
    model: `model-${index + 1}`,
    tokens: 170 + index,
  }));
  const rendered = await render(rows);
  try {
    expect(rendered.host.textContent).toContain("51 rows");
    expect(rendered.host.textContent).toContain("1–50 / 51");
    expect(rendered.host.textContent).toContain("All rows total");
    expect(rendered.host.textContent).toContain("model-51");
    expect(rendered.host.textContent).not.toContain("model-29standard");

    const next = nodes(rendered.host).find(node => node.tagName === "BUTTON" && node.textContent === "Next");
    if (!next) throw new Error("Next button not found");
    await invoke(next, "onClick");
    expect(rendered.host.textContent).toContain("51–51 / 51");
    expect(rendered.host.textContent).toContain("model-29");
    const tokens = nodes(rendered.host).find(node => node.className === "data-table-sort-button" && node.textContent.startsWith("Tokens"))!;
    await invoke(tokens, "onClick", { stopPropagation() {} });
    expect(rendered.host.textContent).toContain("1–50 / 51");
    const tableRows = nodes(rendered.host).find(node => node.tagName === "TBODY")!.children;
    expect(tableRows[0]!.textContent).toContain("model-51");
    expect(tableRows[49]!.textContent).toContain("model-2");
  } finally {
    await cleanup(rendered);
  }
});


test("row drawers keep bucket details out of the table and hide only globally empty columns", () => {
  setLanguage("en");
  const rows = Array.from({ length: 51 }, (_, index) => row({ model: "model-" + index,
    quantities: { ...baseQuantities, in_cache_write_1h: index === 50 ? 123456 : 0 } }));
  const html = renderToStaticMarkup(<SubscriptionModelDetails rows={rows} account="codex1" />);
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('class="ui-open-row"');
  expect(html).not.toContain("Show quantity × rate and source");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("Actual pricing");
  expect(html).not.toContain("Cache write unknown");
  expect(html).toContain("Cache write 1h");
  expect(html).toContain("Cache write 5m");
  expect(html).toContain("123,456");
  const missing = row({ api_actual: null, pricing_note: undefined,
    rates: { ...baseRates, in_uncached: null }, costs: { ...baseCosts, in_uncached: null } });
  const body = renderToStaticMarkup(<SubscriptionModelDetailBody row={missing} account="codex1" />);
  expect(body).toContain("no rate");
  expect(body).toContain("missing rates");
  expect(body).toContain('href="https://example.test/pricing"');
  expect(body).not.toContain("Pricing note");
  expect(body).toContain("API Standard");
});


test.each(["button", "row"])("opens model details with the %s and restores focus on close", async target => {
  const rendered = await render([row()]);
  try {
    const opener = nodes(rendered.host).find(node => node.tagName === "BUTTON" && node.className === "ui-open-row-button")!;
    const focus = spyOn(opener, "focus");
    if (target === "button") await invoke(opener, "onClick", { currentTarget: opener, stopPropagation() {} });
    else {
      const tableRow = nodes(rendered.host).find(node => node.tagName === "TR" && node.className === "ui-open-row")!;
      await invoke(tableRow, "onClick", { currentTarget: { querySelector: () => opener } });
    }
    expect(nodes(rendered.host).find(node => node.tagName === "DIALOG")?.hasAttribute("open")).toBe(true);
    expect(nodes(rendered.host).some(node => node.className === "ui-open-row is-selected")).toBe(true);
    expect(rendered.host.textContent).toContain("Actual pricing");
    const close = nodes(rendered.host).find(node => node.getAttribute("aria-label") === "Close model details")!;
    await invoke(close, "onClick");
    expect(nodes(rendered.host).some(node => node.tagName === "DIALOG")).toBe(false);
    expect(rendered.host.textContent).not.toContain("Actual pricing");
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  } finally { await cleanup(rendered); }
});

test("missing model rates use words in both languages and unknown cache-write quantities stay visible", () => {
  try {
    for (const language of ["en", "pl"] as const) {
      setLanguage(language);
      const missing = row({ api_standard: null, api_actual: null, quantities: { ...baseQuantities, in_cache_write_unknown: Number.NaN },
        rates: { ...baseRates, in_uncached: null }, costs: { ...baseCosts, in_uncached: null } });
      const table = renderToStaticMarkup(<SubscriptionModelDetails rows={[missing]} account="codex1" />);
      const body = renderToStaticMarkup(<SubscriptionModelDetailBody row={missing} account="codex1" />);
      for (const html of [table, body]) expect(html).toContain(`class="ui-missing">${language === "en" ? "no rate" : "brak stawki"}</span>`);
      expect(table).toContain(language === "en" ? "Cache write unknown" : "Zapis cache nieznany");
    }
  } finally { setLanguage("en"); }
});

test("model table retains saved column IDs, order and visibility with conditional cache-write columns", () => {
  setLanguage("en");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    saveTableColumns("SubscriptionModelDetails:0", { order: ["c8", "token:in_cache_write_1h", "c0", "c1"], hidden: ["c1"] });
    const table = (write: number) => renderToStaticMarkup(<SubscriptionModelDetails account="codex1"
      rows={[row({ quantities: { ...baseQuantities, in_cache_write_1h: write } })]} />);
    const first = table(0);
    expect(first).not.toContain('data-column-id="token:in_cache_write_1h"');
    const restored = table(123456);
    expect(restored).not.toContain('data-column-id="c1"');
    expect(restored.indexOf('data-column-id="c8"')).toBeLessThan(restored.indexOf('data-column-id="token:in_cache_write_1h"'));
    const body = restored.split("<tbody>")[1]!.split("</tbody>")[0]!;
    expect(body.indexOf("$1.23")).toBeLessThan(body.indexOf("123,456"));
    expect(body.indexOf("123,456")).toBeLessThan(body.indexOf("2026-09-11"));
    expect(table(123456)).toBe(restored);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
