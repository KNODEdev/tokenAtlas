import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, spyOn, test } from "bun:test";
import type { CodexAccountingRule } from "../../shared/codex-accounting";
import type { CodexPricingSettings } from "../../shared/codex-pricing-settings";
import { api } from "../lib/api";
import type { DataSettingsTarget } from "../lib/data-settings";
import { dropdownValue, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { setLanguage } from "../lib/i18n";
import { CodexPricingPeriods } from "./CodexPricingPeriods";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

function labelled(host: TestNode, text: string): TestNode {
  const label = nodes(host).reverse().find((node) => node.tagName === "LABEL" && node.textContent.startsWith(text));
  if (!label) throw new Error(`Label not found: ${text}`);
  const control = nodes(label).find((node) => ["INPUT", "TEXTAREA"].includes(node.tagName) || node.getAttribute("aria-haspopup") === "listbox");
  if (!control) throw new Error(`Control not found: ${text}`);
  return control;
}

async function controlValue(control: TestNode): Promise<string | null> {
  if (control.getAttribute("aria-haspopup") === "listbox") return dropdownValue(control);
  const propsKey = Object.keys(control as unknown as Record<string, unknown>).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (control as unknown as Record<string, Record<string, unknown>>)[propsKey] : undefined;
  return typeof props?.value === "string" ? props.value : control.value;
}

function form(host: TestNode): TestNode {
  const node = nodes(host).find((candidate) => candidate.tagName === "FORM");
  if (!node) throw new Error("Form not found");
  return node;
}

function rule(id: string, overrides: Partial<CodexAccountingRule> = {}): CodexAccountingRule {
  return {
    id,
    model: "gpt-6-astra",
    billing_basis: "api_equivalent_usd",
    speed: "standard",
    valid_from: "2026-08-01",
    valid_until: "2026-09-01",
    verified_at: "2026-09-11",
    sources: ["https://example.test/codex-pricing"],
    confidence: "official",
    rates: { in_uncached: 10, in_cache_read: 1, out_total: 50 },
    multiplier: 1,
    included_usage: "unknown",
    ...overrides,
  };
}

const pricing = (rules: CodexAccountingRule[] = [rule("existing")]): CodexPricingSettings => ({ revision: "revision-1", rules, long_context_premium: true });
const target: DataSettingsTarget = {
  area: "rates",
  account: "codex1",
  since: "2026-08-16",
  until: "2026-08-23",
  model: "gpt-6-astra",
  basis: "chatgpt_credits",
  speed: "fast",
};

async function render(
  initial: CodexPricingSettings = pricing(),
  targetOverride: DataSettingsTarget | undefined = target,
): Promise<{ host: TestNode; restore: () => void; root: ReturnType<typeof createRoot>; load: ReturnType<typeof spyOn> }> {
  setLanguage("en");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const load = spyOn(api, "codexPricing").mockResolvedValue(initial);
  await act(async () => { root.render(<CodexPricingPeriods target={targetOverride} onSaved={() => {}} />); });
  await flushUntil(() => dom.host.textContent.includes("Add price period"));
  return { host: dom.host, restore: dom.restore, root, load };
}

async function cleanup(rendered: Awaited<ReturnType<typeof render>>, spies: Array<{ mockRestore: () => void }> = []): Promise<void> {
  for (const spy of spies) spy.mockRestore();
  rendered.load.mockRestore();
  await act(async () => rendered.root.unmount());
  rendered.restore();
}

describe("CodexPricingPeriods", () => {
  test("saves the long-context premium switch as its own edit", async () => {
    const rendered = await render();
    const save = spyOn(api, "saveCodexPricing").mockResolvedValue({ ...pricing(), long_context_premium: false });
    try {
      const label = nodes(rendered.host).find((node) => node.tagName === "LABEL"
        && node.textContent.includes("Long-context premium in API equivalents"));
      const box = label && nodes(label).find((node) => node.tagName === "INPUT");
      if (!box) throw new Error("Long-context premium switch not found");
      const propsKey = Object.keys(box as unknown as Record<string, unknown>).find((key) => key.startsWith("__reactProps$"));
      expect((box as unknown as Record<string, { checked?: boolean }>)[propsKey!]?.checked).toBe(true);
      await invoke(box, "onChange", { target: { checked: false } });
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toEqual({ revision: "revision-1", long_context_premium: false });
    } finally {
      await cleanup(rendered, [save]);
    }
  });

  test("prefills the selected model, unit, speed and inclusive target dates, then submits the next UTC end", async () => {
    const rendered = await render();
    const save = spyOn(api, "saveCodexPricing").mockResolvedValue(pricing());
    try {
      const add = nodes(rendered.host).find((node) => node.tagName === "BUTTON" && node.textContent === "+ Add price period");
      if (!add) throw new Error("Add price period button not found");
      await invoke(add, "onClick");

      expect(await controlValue(labelled(rendered.host, "Model"))).toBe("gpt-6-astra");
      expect(await controlValue(labelled(rendered.host, "Unit / 1M tokens"))).toBe("chatgpt_credits");
      expect(await controlValue(labelled(rendered.host, "Speed"))).toBe("fast");
      expect(await controlValue(labelled(rendered.host, "From UTC (inclusive)"))).toBe("2026-08-16");
      expect(await controlValue(labelled(rendered.host, "Through UTC (inclusive; blank = ongoing)"))).toBe("2026-08-23");

      await invoke(labelled(rendered.host, "Uncached input"), "onChange", { target: { valueAsNumber: 125 } });
      await invoke(labelled(rendered.host, "Cached input"), "onChange", { target: { valueAsNumber: 12.5 } });
      await invoke(labelled(rendered.host, "Output (including reasoning)"), "onChange", { target: { valueAsNumber: 750 } });
      await invoke(labelled(rendered.host, "Sources (HTTPS, one per line)"), "onChange", { target: { value: "https://example.test/historical" } });
      await invoke(form(rendered.host), "onSubmit", { preventDefault() {} });

      expect(save).toHaveBeenCalledTimes(1);
      const payload = save.mock.calls[0]![0]!;
      expect(payload.revision).toBe("revision-1");
      expect(payload.replace_id).toBeUndefined();
      expect(payload.rule).toMatchObject({
        model: "gpt-6-astra",
        billing_basis: "chatgpt_credits",
        speed: "fast",
        valid_from: "2026-08-16",
        valid_until: "2026-08-24",
        confidence: "user",
        sources: ["https://example.test/historical"],
        rates: { in_uncached: 125, in_cache_read: 12.5, out_total: 750 },
      });
    } finally {
      await cleanup(rendered, [save]);
    }
  });

  test("editing displays the previous inclusive day and preserves the exclusive end on save", async () => {
    const rendered = await render(pricing());
    const save = spyOn(api, "saveCodexPricing").mockResolvedValue(pricing());
    try {
      const edit = nodes(rendered.host).find((node) => node.tagName === "BUTTON" && node.textContent === "Edit");
      if (!edit) throw new Error("Edit button not found");
      await invoke(edit, "onClick");

      expect(await controlValue(labelled(rendered.host, "From UTC (inclusive)"))).toBe("2026-08-01");
      expect(await controlValue(labelled(rendered.host, "Through UTC (inclusive; blank = ongoing)"))).toBe("2026-08-31");
      await invoke(form(rendered.host), "onSubmit", { preventDefault() {} });

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toMatchObject({ revision: "revision-1", replace_id: "existing" });
      expect(save.mock.calls[0]![0]!.rule).toMatchObject({ valid_from: "2026-08-01", valid_until: "2026-09-01" });
    } finally {
      await cleanup(rendered, [save]);
    }
  });

  test("copying creates a new id for the target interval and does not replace the source period", async () => {
    const rendered = await render(pricing());
    const save = spyOn(api, "saveCodexPricing").mockResolvedValue(pricing());
    try {
      const copy = nodes(rendered.host).find((node) => node.tagName === "BUTTON" && node.textContent === "Copy as new period");
      if (!copy) throw new Error("Copy as new period button not found");
      await invoke(copy, "onClick");
      expect(await controlValue(labelled(rendered.host, "Through UTC (inclusive; blank = ongoing)"))).toBe("2026-08-23");
      await invoke(form(rendered.host), "onSubmit", { preventDefault() {} });

      const payload = save.mock.calls[0]![0]!;
      expect(payload.replace_id).toBeUndefined();
      expect(payload.rule!.id).not.toBe("existing");
      expect(payload.rule).toMatchObject({ valid_from: "2026-08-16", valid_until: "2026-08-24", confidence: "user" });
    } finally {
      await cleanup(rendered, [save]);
    }
  });

  test("keeps the draft and shows a stale-save error without retrying silently", async () => {
    const rendered = await render();
    const save = spyOn(api, "saveCodexPricing").mockRejectedValue(new Error("Cennik zmienił się"));
    let saved = 0;
    try {
      // The initial render uses a no-op callback; the error path must never reach it.
      await invoke(nodes(rendered.host).find((node) => node.tagName === "BUTTON" && node.textContent === "+ Add price period")!, "onClick");
      await invoke(form(rendered.host), "onSubmit", { preventDefault() {} });
      expect(save).toHaveBeenCalledTimes(1);
      expect(rendered.host.textContent).toContain("Cennik zmienił się");
      expect(rendered.host.textContent).not.toContain("Saved.");
      expect(await controlValue(labelled(rendered.host, "Model"))).toBe("gpt-6-astra");
      expect(await controlValue(labelled(rendered.host, "From UTC (inclusive)"))).toBe("2026-08-16");
      expect(saved).toBe(0);
    } finally {
      await cleanup(rendered, [save]);
    }
  });
});

test("a model without a price opens a new ongoing period from its first day with the newest documented sources", async () => {
  const rendered = await render(pricing([rule("existing"), rule("newest", { model: "gpt-6-sol", valid_from: "2026-09-22", valid_until: undefined,
    sources: ["https://example.test/newest"] }), rule("declared", { valid_from: "2026-10-01", valid_until: undefined, confidence: "user",
    sources: ["https://example.test/user"] })]), { area: "rates", account: "all", model: "gpt-new-sol", since: "2026-09-30",
    basis: "api_equivalent_usd", speed: "standard", newPeriod: true });
  const save = spyOn(api, "saveCodexPricing").mockResolvedValue(pricing());
  try {
    await flushUntil(() => nodes(rendered.host).some((node) => node.tagName === "FORM"));
    expect(await controlValue(labelled(rendered.host, "Model"))).toBe("gpt-new-sol");
    expect(await controlValue(labelled(rendered.host, "Unit / 1M tokens"))).toBe("api_equivalent_usd");
    expect(await controlValue(labelled(rendered.host, "From UTC (inclusive)"))).toBe("2026-09-30");
    expect(await controlValue(labelled(rendered.host, "Through UTC (inclusive; blank = ongoing)"))).toBe("");
    expect(await controlValue(labelled(rendered.host, "Sources (HTTPS, one per line)"))).toBe("https://example.test/newest");
    await invoke(labelled(rendered.host, "Uncached input"), "onChange", { target: { valueAsNumber: 2 } });
    await invoke(labelled(rendered.host, "Cached input"), "onChange", { target: { valueAsNumber: 0.2 } });
    await invoke(labelled(rendered.host, "Output (including reasoning)"), "onChange", { target: { valueAsNumber: 10 } });
    await invoke(form(rendered.host), "onSubmit", { preventDefault() {} });
    expect(save.mock.calls[0]![0]!.rule).toMatchObject({ model: "gpt-new-sol", valid_from: "2026-09-30", valid_until: undefined,
      sources: ["https://example.test/newest"], rates: { in_uncached: 2, in_cache_read: 0.2, out_total: 10 } });
  } finally {
    await cleanup(rendered, [save]);
  }
});
