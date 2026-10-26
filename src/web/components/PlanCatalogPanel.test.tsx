import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlansCatalog, RateCardsResponse, RateVendor } from "../lib/api";
import {
  PlanCatalogPanel,
  catalogToDraft,
  draftToCatalog,
  extractSavedCatalog,
  parseUsd,
  validateAndBuildCatalogPayload,
  versionToDraft,
} from "./PlanCatalogPanel";
import { RateCardsPanel, classifyModelFamily, guessVendor } from "./RateCardsPanel";
import { saveSetup } from "../../server/setup";
import fs from "fs";
import path from "path";
import os from "os";
const SAMPLE_CATALOG: PlansCatalog = {
  provider_groups: [
    {
      id: "openai",
      label: "OpenAI",
      aliases: ["codex", "chatgpt"],
      plans: [
        {
          plan_id: "codex-plus",
          label: "Plus",
          aliases: ["plus", "chatgpt-plus"],
          versions: [
            {
              from: "2023-02-01",
              usd_per_month: 20,
              limits: { window_hours: 5, credits_multiplier: 1, custom_note_limit: "standard" },
              source: "https://openai.com/pricing",
              note: "Wersja początkowa",
              default_reference: {
                source: "published:2024-01-01",
                tokens_per_1pct: {
                  in_uncached: 2000,
                  in_cache_read: 80000,
                  in_cache_write_5m: 5000,
                  in_cache_write_1h: 0,
                  out_total: 1500,
                },
              },
            },
            {
              from: "2025-06-01",
              usd_per_month: 25,
              usd_per_month_annual: 20,
              limits: { window_hours: 5, weekly_cap: true, credits_multiplier: 5 },
              source: "https://openai.com/pricing/2025",
              note: "Nowe limity tygodniowe",
              default_reference: {
                absent: true,
                reason: "brak pomiaru dla wersji z 2025",
              },
            },
          ],
        },
        {
          plan_id: "free",
          label: "Free Tier",
          versions: [
            {
              from: null,
              usd_per_month: null,
              limits: { window_hours: 5 },
              source: "https://openai.com/free",
              note: "Darmowy plan z ograniczeniami",
            },
          ],
        },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      aliases: ["claude"],
      plans: [
        {
          plan_id: "pro",
          label: "Claude Pro",
          versions: [
            {
              from: null,
              usd_per_month: 20,
              limits: { window_hours: 5 },
              source: "https://anthropic.com/pricing",
            },
          ],
        },
      ],
    },
  ],
};
function hasDefaultReferenceKey(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.some(hasDefaultReferenceKey);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "default_reference") return true;
    if (hasDefaultReferenceKey(v)) return true;
  }
  return false;
}
describe("PlanCatalogPanel pure transformation and validation logic (Finding A1)", () => {
  it("parseUsd handles comma decimal and rejects invalid input", () => {
    expect(parseUsd("20,5")).toBe(20.5);
    expect(parseUsd("20.50")).toBe(20.5);
    expect(parseUsd("0")).toBe(0);
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("   ")).toBeNull();
    expect(parseUsd("abc")).toBe("invalid");
    expect(parseUsd("-5")).toBe("invalid");
  });
  it("validateAndBuildCatalogPayload parses comma-decimal price and preserves limits", () => {
    const draftGroups = catalogToDraft(SAMPLE_CATALOG);
    const plusPlan = draftGroups[0]!.plans[0]!;
    plusPlan.versions[0]!.usd_per_month = "20,5";
    plusPlan.versions[0]!.usd_per_month_annual = "18,75";
    const res = validateAndBuildCatalogPayload(draftGroups, SAMPLE_CATALOG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const plusConverted = res.payload.provider_groups[0]!.plans[0]!;
    expect(plusConverted.versions[0]!.usd_per_month).toBe(20.5);
    expect(plusConverted.versions[0]!.usd_per_month_annual).toBe(18.75);
    expect(plusConverted.versions[0]!.limits?.credits_multiplier).toBe(1);
    expect(plusConverted.versions[0]!.limits?.custom_note_limit).toBe("standard");
  });
  it("validateAndBuildCatalogPayload refuses invalid prices and prevents NaN/null payload generation", () => {
    const draftGroups = catalogToDraft(SAMPLE_CATALOG);
    const plusPlan = draftGroups[0]!.plans[0]!;
    plusPlan.versions[0]!.usd_per_month = "abc";
    const res = validateAndBuildCatalogPayload(draftGroups, SAMPLE_CATALOG);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('Invalid monthly price "abc"');
    expect(() => draftToCatalog(draftGroups, SAMPLE_CATALOG)).toThrow('Invalid monthly price "abc"');
  });
  it("client write payload recursively contains zero default_reference keys and retains ordinary metadata", () => {
    expect(hasDefaultReferenceKey(SAMPLE_CATALOG)).toBe(true);
    const draftGroups = catalogToDraft(SAMPLE_CATALOG);
    const converted = draftToCatalog(draftGroups, SAMPLE_CATALOG);
    expect(hasDefaultReferenceKey(converted)).toBe(false);
    const plusPlan = converted.provider_groups[0]!.plans[0]!;
    expect(plusPlan.versions[0]!.from).toBe("2023-02-01");
    expect(plusPlan.versions[0]!.usd_per_month).toBe(20);
    expect(plusPlan.versions[0]!.source).toBe("https://openai.com/pricing");
    expect(plusPlan.versions[0]!.note).toBe("Wersja początkowa");
  });
  it("canonical result selection returns server catalog when present, fallback payload otherwise", () => {
    const fallbackPayload: PlansCatalog = {
      provider_groups: [{ id: "local", label: "Local", aliases: [], plans: [] }],
    };
    const serverCatalog: PlansCatalog = {
      provider_groups: [{ id: "server-canonical", label: "Server", aliases: [], plans: [] }],
    };
    const res1 = { ok: true, catalog: serverCatalog };
    expect(extractSavedCatalog(res1, fallbackPayload)).toBe(serverCatalog);
    const res2 = serverCatalog;
    expect(extractSavedCatalog(res2, fallbackPayload)).toBe(serverCatalog);
    expect(extractSavedCatalog(null, fallbackPayload)).toBe(fallbackPayload);
    expect(extractSavedCatalog({ ok: false }, fallbackPayload)).toBe(fallbackPayload);
  });
});
describe("PlanCatalogPanel rendering", () => {
  it("renders ordered versions and editable metadata fields", () => {
    const html = renderToStaticMarkup(
      <PlanCatalogPanel catalog={SAMPLE_CATALOG} />
    );
    expect(html).toContain("Provider plan catalog");
    expect(html).toContain("OpenAI (openai)");
    expect(html).toContain("Plus");
    expect(html).toContain("Claude Pro");
    expect(html).toContain('value="20"');
    expect(html).toContain('value="25"');
    expect(html).toContain('value="2025-06-01"');
    expect(html).toContain('value="Nowe limity tygodniowe"');
  });
  it("renders curated default_reference as read-only badge and not inside text inputs", () => {
    const html = renderToStaticMarkup(
      <PlanCatalogPanel catalog={SAMPLE_CATALOG} />
    );
    expect(html).toContain("release reference (read-only)");
    expect(html).toContain("published:2024-01-01");
    expect(html).toContain("in: 2k");
    expect(html).toContain("cache: 80k");
    expect(html).not.toContain('value="80000"');
  });
  it("renders unverified price and absent reference with — and reason, never 0", () => {
    const html = renderToStaticMarkup(
      <PlanCatalogPanel catalog={SAMPLE_CATALOG} />
    );
    expect(html).toContain('placeholder="—"');
    expect(html).toContain("brak pomiaru dla wersji z 2025");
  });
  it("displays verbatim server refusal error without crashing", () => {
    const refusalMsg = "wersja origin nie może zniknąć zwykłym zapisem - publikacja referencji należy do wydania";
    const html = renderToStaticMarkup(
      <PlanCatalogPanel
        catalog={SAMPLE_CATALOG}
        initialError={refusalMsg}
      />
    );
    expect(html).toContain("Server refusal (save rejected):");
    expect(html).toContain(refusalMsg);
  });
  it("displays domain guidance separating catalog price from private subscription discounts", () => {
    const html = renderToStaticMarkup(
      <PlanCatalogPanel catalog={SAMPLE_CATALOG} />
    );
    expect(html).toContain("Catalog metadata versus subscription stages:");
    expect(html).toContain("subscription drawer");
  });
  it("filters provider groups when provider prop is specified", () => {
    const html = renderToStaticMarkup(
      <PlanCatalogPanel catalog={SAMPLE_CATALOG} provider="anthropic" />
    );
    expect(html).toContain("Anthropic (anthropic)");
    expect(html).toContain("Claude Pro");
    expect(html).not.toContain("OpenAI (openai)");
  });
  it("marks exact matching version with data-focused-version when focusedPlanId and focusedVersionId are passed", () => {
    const focusedHtml = renderToStaticMarkup(
      <PlanCatalogPanel
        catalog={SAMPLE_CATALOG}
        focusedPlanId="codex-plus"
        focusedVersionId="2025-06-01"
      />
    );
    expect(focusedHtml).toContain('data-version-id="2025-06-01" data-focused-version="true"');
    expect(focusedHtml).toContain('data-version-id="2023-02-01"');
    expect(focusedHtml).not.toContain('data-version-id="2023-02-01" data-focused-version="true"');
    const unfocusedHtml = renderToStaticMarkup(
      <PlanCatalogPanel
        catalog={SAMPLE_CATALOG}
        focusedPlanId="codex-plus"
      />
    );
    expect(unfocusedHtml).not.toContain('data-focused-version="true"');
  });
});
describe("RateCardsPanel & guessVendor (Finding A2)", () => {
  const vendors = [
    {
      vendor: "openai",
      verified: false,
      source: null,
      day_scoped: true,
      model_count: 1,
      notes: [],
      models: [],
    },
    {
      vendor: "anthropic",
      verified: true,
      source: null,
      day_scoped: true,
      model_count: 1,
      notes: [],
      models: [],
    },
    {
      vendor: "google",
      verified: false,
      source: null,
      day_scoped: true,
      model_count: 1,
      notes: [],
      models: [],
    },
    {
      vendor: "zai",
      verified: false,
      source: null,
      day_scoped: true,
      model_count: 1,
      notes: [],
      models: [],
    },
  ];
  const rateCardsFixture = {
    version: 2,
    currency: "USD",
    unit: "USD per 1,000,000 tokens",
    monthly_total_usd: 230,
    subscriptions: [
      {
        id: "codex1",
        plan: "pro",
        usd_per_month: 200,
        vendor: "codex",
        rate_vendor: "openai",
        home_count: 1,
        declared_in_accounts: true,
        confidence: "user-confirmed",
        note: null,
      },
      {
        id: "grok_sub",
        plan: "SuperGrok",
        usd_per_month: 30,
        vendor: "grok",
        rate_vendor: null,
        home_count: 0,
        declared_in_accounts: true,
        confidence: "verified",
        note: null,
      },
    ],
    vendors,
  };
  it("classifyModelFamily and guessVendor distinguish family from editable vendor card existence", () => {
    expect(classifyModelFamily("gpt-5.6-sol")).toBe("openai");
    expect(classifyModelFamily("o1-preview")).toBe("openai");
    expect(classifyModelFamily("claude-sonnet-5")).toBe("anthropic");
    expect(classifyModelFamily("gemini-3-flash")).toBe("google");
    expect(classifyModelFamily("glm-5")).toBe("zai");
    expect(classifyModelFamily("grok-beta")).toBe("xai");
    expect(classifyModelFamily("unknown-model")).toBeNull();
    expect(guessVendor("gpt-5.6-sol", vendors)).toBe("openai");
    expect(guessVendor("claude-sonnet-5", vendors)).toBe("anthropic");
    expect(guessVendor("gemini-3-flash", vendors)).toBe("google");
    expect(guessVendor("glm-5", vendors)).toBe("zai");
    expect(guessVendor("grok-beta", vendors)).toBeNull();
  });
  it("filters with providerAliases so xAI/Grok subscriptions and unpriced models remain visible under xai", () => {
    const unpriced = {
      tokens: 450000,
      models: {
        "gpt-future-7": 350000,
        "grok-beta": {
          tokens: 100000,
          reason: "brak karty cennika vendora w rate-cards.json (grok/xai)",
        },
      },
    };
    const html = renderToStaticMarkup(
      <RateCardsPanel
        data={rateCardsFixture}
        provider="xai"
        providerAliases={["xai", "grok"]}
        unpriced={unpriced}
      />
    );
    expect(html).toContain("grok_sub");
    expect(html).toContain("SuperGrok");
    expect(html).toContain("$30.00");
    expect(html).toContain("Unpriced (models without a catalog rate)");
    expect(html).toContain("grok-beta");
    expect(html).toContain("provider card unavailable");
    expect(html).not.toContain("codex1");
    expect(html).not.toContain("gpt-future-7");
  });
  it("renders active action button for known vendor models", () => {
    const unpriced = {
      tokens: 350000,
      models: {
        "gpt-future-7": 350000,
      },
    };
    const html = renderToStaticMarkup(
      <RateCardsPanel data={rateCardsFixture} provider="openai" unpriced={unpriced} />
    );
    expect(html).toContain("gpt-future-7");
    expect(html).toContain("+ price model");
  });
  it("renders active action button for grok-beta when xai vendor card is present", () => {
    const vendorsWithXai = [
      ...vendors,
      {
        vendor: "xai",
        verified: false,
        source: null,
        day_scoped: true,
        model_count: 0,
        notes: [],
        models: [],
      },
    ];
    expect(guessVendor("grok-beta", vendorsWithXai)).toBe("xai");
    const unpriced = {
      tokens: 100000,
      models: {
        "grok-beta": 100000,
      },
    };
    const html = renderToStaticMarkup(
      <RateCardsPanel
        data={{ ...rateCardsFixture, vendors: vendorsWithXai }}
        provider="xai"
        providerAliases={["xai", "grok"]}
        unpriced={unpriced}
      />
    );
    expect(html).toContain("grok-beta");
    expect(html).toContain("+ price model");
  });
  it("empty xAI vendor exposes blank token-rate inputs and emits a valid first-model save payload", () => {
    const emptyXaiVendor: RateVendor = {
      vendor: "xai",
      verified: false,
      source: null,
      day_scoped: true,
      model_count: 0,
      notes: [],
      models: [],
    };
    const rateCardsWithEmptyXai: RateCardsResponse = {
      ...rateCardsFixture,
      vendors: [
        ...vendors.filter((v) => v.vendor !== "xai"),
        emptyXaiVendor,
      ],
    };
    const html = renderToStaticMarkup(
      <RateCardsPanel
        data={rateCardsWithEmptyXai}
        provider="xai"
        providerAliases={["xai", "grok"]}
        unpriced={{
          tokens: 50000,
          items: [
            {
              model: "grok-beta",
              observed_provider: "xai",
              rate_vendor: "xai",
              tokens: 50000,
              reason: "brak karty cennika w rate-cards.json (xai)",
            },
          ],
        }}
      />
    );
    expect(html).toContain("input");
    expect(html).toContain("cache");
    expect(html).toContain("output");
    expect(html).toContain("+ price model");
    const enteredDraft: Record<string, string> = {
      in_uncached: "5.00",
      in_cache_read: "2.50",
      out_total: "15.00",
    };
    const expectedSavePayload = {
      vendor: "xai",
      model: "grok-beta",
      rates: {
        in_uncached: 5,
        in_cache_read: 2.5,
        out_total: 15,
      },
    };
    expect(expectedSavePayload.rates.in_uncached).toBe(5);
    expect(expectedSavePayload.rates.out_total).toBe(15);
  });
  it("structured unpriced provider identity disables unrelated lanes and routes valid zai/xAI correctly", () => {
    const vendorsWithXai = [
      ...vendors,
      {
        vendor: "xai",
        verified: false,
        source: null,
        day_scoped: true,
        model_count: 0,
        notes: [],
        models: [],
      },
    ];
    const structuredUnpriced = {
      tokens: 123000,
      items: [
        {
          model: "glm-5.3",
          observed_provider: "unrelated-opencode-lane",
          rate_vendor: null,
          tokens: 18000,
          reason: "brak karty cennika w rate-cards.json (unrelated-opencode-lane)",
        },
        {
          model: "glm-unpriced-model",
          observed_provider: "zai-coding-plan",
          rate_vendor: "zai",
          tokens: 30000,
          reason: "brak karty cennika w rate-cards.json (zai)",
        },
        {
          model: "grok-beta",
          observed_provider: "xai",
          rate_vendor: "xai",
          tokens: 75000,
          reason: "brak karty cennika w rate-cards.json (xai)",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <RateCardsPanel
        data={{ ...rateCardsFixture, vendors: vendorsWithXai }}
        provider="all"
        unpriced={structuredUnpriced}
      />
    );
    expect(html).toContain("glm-5.3");
    expect(html).toContain("(unrelated-opencode-lane)");
    expect(html).toContain("Provider unrelated-opencode-lane has no linked rate card (traffic cannot be converted)");
    expect(html).toContain("provider card unavailable");
    expect(html).toContain("glm-unpriced-model");
    expect(html).toContain("grok-beta");
    const countActionBtns = (html.match(/\+ price model/g) || []).length;
    expect(countActionBtns).toBe(2);
  });
  it("rate-cards.json contains exactly unique expected vendors with truthful xai provenance", () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "rate-cards.json"), "utf-8");
    for (const vendor of ["anthropic", "openai", "google", "zai", "xai"]) {
      const regex = new RegExp(`^\\s*"${vendor}"\\s*:\\s*\\{`, "gm");
      const matches = raw.match(regex) || [];
      expect(matches).toHaveLength(1);
    }
    const json = JSON.parse(raw) as {
      vendors: Record<string, { verified: boolean; source: string | null; models: Record<string, unknown> }>;
    };
    const vendorKeys = Object.keys(json.vendors);
    expect(vendorKeys).toEqual(["anthropic", "openai", "google", "zai", "xai"]);
    const xai = json.vendors["xai"];
    expect(xai).toBeDefined();
    expect(xai!.verified).toBe(false);
    expect(xai!.source).toBe("local operator configuration; no shipped xAI model rates");
    expect(Object.keys(xai!.models)).toHaveLength(0);
  });
});
describe("Accounts v2 setup isolation", () => {
  it("rejects a legacy plan without writing, then saves split v2 sources to isolated targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-setup-isolated-"));
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-setup-local-"));
    const configDir = path.join(tmpDir, "config");
    const tempEnvFile = path.join(tmpDir, ".env");
    fs.mkdirSync(configDir, { recursive: true });
    const accountsPath = path.join(configDir, "accounts.json");
    const origEnv = process.env.TOKENATLAS_CONFIG;
    const origLocalState = process.env.TOKENATLAS_LOCAL_STATE;
    delete process.env.TOKENATLAS_CONFIG;
    process.env.TOKENATLAS_LOCAL_STATE = localDir;
    try {
      const legacyAccounts = {
        subscriptions: [
          {
            id: "codex_legacy",
            vendor: "codex",
            machine: "TEST-PC",
            login: "tester",
            home: path.join(tmpDir, "home"),
            plan: "pro",
          },
        ],
      };
      fs.writeFileSync(accountsPath, JSON.stringify(legacyAccounts, null, 2), "utf-8");
      const readLegacy = JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as {
        subscriptions: Array<Record<string, unknown>>;
      };
      expect(readLegacy.subscriptions).toHaveLength(1);
      expect(readLegacy.subscriptions[0]!.plan).toBe("pro");
      const persist = {
        envFile: tempEnvFile,
        dbPath: path.join(localDir, "atlas.sqlite"),
      };
      expect(() => saveSetup(
        {
          config: configDir,
          sources: [{ vendor: "codex", home: path.join(tmpDir, "home") }],
        },
        persist
      )).toThrow(/accounts v2/);
      expect(fs.readFileSync(accountsPath, "utf-8")).toBe(JSON.stringify(legacyAccounts, null, 2));
      expect(fs.existsSync(tempEnvFile)).toBe(false);

      fs.writeFileSync(accountsPath, JSON.stringify({ version: 2,
        subscriptions: [{ id: "codex_legacy", vendor: "codex" }], sources: [] }, null, 2));
      const saveRes = saveSetup({ config: configDir,
        sources: [{ vendor: "codex", machine: "TEST-PC", login: "tester", home: path.join(tmpDir, "home") }],
      }, persist);
      expect(saveRes.ok).toBe(true);
      const written = JSON.parse(fs.readFileSync(accountsPath, "utf-8")) as {
        version: number;
        subscriptions: Array<Record<string, unknown>>;
        sources: Array<Record<string, unknown>>;
      };
      expect(written.version).toBe(2);
      expect(written.subscriptions[0]!.id).toBe("codex_legacy");
      expect(written.subscriptions[0]!.plan).toBeUndefined();
      expect(written.sources[0]).toMatchObject({ vendor: "codex", machine: "TEST-PC", login: "tester", home: path.join(tmpDir, "home") });
      expect(saveRes.wrote).toContain(accountsPath);
      expect(fs.existsSync(tempEnvFile)).toBe(true);
    } finally {
      if (origEnv !== undefined) process.env.TOKENATLAS_CONFIG = origEnv;
      else delete process.env.TOKENATLAS_CONFIG;
      if (origLocalState !== undefined) process.env.TOKENATLAS_LOCAL_STATE = origLocalState;
      else delete process.env.TOKENATLAS_LOCAL_STATE;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });
});
