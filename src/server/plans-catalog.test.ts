import { describe, expect, it, spyOn } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { handlePlansCatalog, handlePlansCatalogSave, type AppContext } from "./api";
import {
  CatalogValidationError,
  loadPlansCatalog,
  loadPublishedCatalog,
  matchPlanAlias,
  overlayPublishedReferences,
  prepareLocalCatalogWrite,
  resolveDefaultReference,
  resolvePlanVersion,
  resolveProviderGroup,
  savePlansCatalog,
  stripDefaultReferences,
  validatePlansCatalog,
  type CatalogPlan,
  type PlansCatalog,
  type PlanVersion,
  type ProviderGroup,
  type TokenVector,
} from "./plans-catalog";
const REPO = path.join(import.meta.dir, "../..");
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-catalog-"));
}
function vector(n: number): TokenVector {
  return {
    in_uncached: n,
    in_cache_read: n,
    in_cache_write_5m: n,
    in_cache_write_1h: n,
    out_total: n,
  };
}
function version(partial: Partial<PlanVersion> & Pick<PlanVersion, "from">): PlanVersion {
  return {
    usd_per_month: 20,
    default_reference: { absent: true, reason: "not measured" },
    ...partial,
  };
}
function catalogOf(groups: ProviderGroup[]): PlansCatalog {
  return { provider_groups: groups };
}
function openaiGroup(plans: CatalogPlan[]): ProviderGroup {
  return { id: "openai", label: "OpenAI", aliases: ["codex", "openai"], plans };
}
const twoVersionPlan: CatalogPlan = {
  plan_id: "claude-pro",
  label: "Pro",
  aliases: ["pro"],
  versions: [
    version({ from: "2023-09-07", usd_per_month: 20 }),
    version({
      from: "2025-08-28",
      usd_per_month: 20,
      default_reference: { absent: true, reason: "weekly cap, no vector" },
    }),
  ],
};
const claudeCatalog: PlansCatalog = catalogOf([
  {
    id: "anthropic",
    label: "Anthropic",
    aliases: ["claude", "anthropic"],
    plans: [twoVersionPlan],
  },
]);
describe("loadPlansCatalog", () => {
  it("yields an empty valid catalog when the file is missing and does not create one", () => {
    const dir = tmpDir();
    const file = path.join(dir, "plans-catalog.json");
    expect(fs.existsSync(file)).toBe(false);
    const loaded = loadPlansCatalog(dir);
    expect(loaded.provider_groups).toEqual([]);
    expect(validatePlansCatalog(loaded)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
  it("does not rewrite a user file on ordinary read", () => {
    const dir = tmpDir();
    const file = path.join(dir, "plans-catalog.json");
    const original = JSON.stringify({ provider_groups: [], _comment: ["legacy"] }, null, 2) + "\n";
    fs.writeFileSync(file, original, "utf-8");
    const before = fs.statSync(file);
    const loaded = loadPlansCatalog(dir);
    expect(loaded.provider_groups).toEqual([]);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });
  it("shipped catalog validates and keeps every seed reference absent", () => {
    const shipped = loadPlansCatalog(REPO);
    expect(validatePlansCatalog(shipped)).toEqual([]);
    expect(shipped.provider_groups.map((g) => g.id)).toEqual(["openai", "anthropic", "zai", "xai", "google"]);
    for (const group of shipped.provider_groups) {
      for (const plan of group.plans) {
        for (const ver of plan.versions) {
          expect(ver.default_reference).toEqual(
            expect.objectContaining({ absent: true, reason: expect.any(String) })
          );
        }
      }
    }
  });
});
describe("provider aliases", () => {
  it("converges adapter and rate-card aliases to the same group", () => {
    const shipped = loadPlansCatalog(REPO);
    const viaCodex = resolveProviderGroup(shipped, "codex");
    const viaOpenAI = resolveProviderGroup(shipped, "OpenAI");
    const viaOpenai = resolveProviderGroup(shipped, "openai");
    expect(viaCodex.kind).toBe("ok");
    expect(viaOpenAI.kind).toBe("ok");
    expect(viaOpenai.kind).toBe("ok");
    if (viaCodex.kind === "ok" && viaOpenAI.kind === "ok" && viaOpenai.kind === "ok") {
      expect(viaCodex.group.id).toBe("openai");
      expect(viaOpenAI.group.id).toBe(viaCodex.group.id);
      expect(viaOpenai.group.id).toBe(viaCodex.group.id);
    }
  });
  it("returns an explicit unassigned result for an unknown alias", () => {
    const result = resolveProviderGroup(loadPlansCatalog(REPO), "not-a-vendor");
    expect(result).toEqual({ kind: "unassigned", reason: "unknown_provider_alias", alias: "not-a-vendor" });
  });
});
describe("resolvePlanVersion", () => {
  it("picks the version in force on the boundary day, not the previous one", () => {
    const onBoundary = resolvePlanVersion(claudeCatalog, "claude", "claude-pro", "2025-08-28");
    const dayBefore = resolvePlanVersion(claudeCatalog, "anthropic", "claude-pro", "2025-08-27");
    expect(onBoundary.kind).toBe("ok");
    expect(dayBefore.kind).toBe("ok");
    if (onBoundary.kind === "ok" && dayBefore.kind === "ok") {
      expect(onBoundary.version_from).toBe("2025-08-28");
      expect(dayBefore.version_from).toBe("2023-09-07");
    }
  });
  it("returns no_version_for_day instead of the nearest version", () => {
    const result = resolvePlanVersion(claudeCatalog, "claude", "claude-pro", "2023-09-06");
    expect(result.kind).toBe("no_version_for_day");
    if (result.kind === "no_version_for_day") {
      expect(result.plan_id).toBe("claude-pro");
      expect(result.day).toBe("2023-09-06");
    }
  });
});
describe("default_reference", () => {
  it("stays absent with a reason and is not inferred from another version", () => {
    const v1 = resolveDefaultReference(claudeCatalog, "claude", "claude-pro", "2024-01-01");
    const v2 = resolveDefaultReference(claudeCatalog, "claude", "claude-pro", "2025-08-28");
    expect(v1).toEqual({
      kind: "absent",
      reason: "not measured",
      version_from: "2023-09-07",
      version_id: "2023-09-07",
    });
    expect(v2).toEqual({
      kind: "absent",
      reason: "weekly cap, no vector",
      version_from: "2025-08-28",
      version_id: "2025-08-28",
    });
  });
  it("does not copy a present vector onto another Plan", () => {
    const withVector: PlansCatalog = catalogOf([
      openaiGroup([
        {
          plan_id: "codex-plus",
          label: "Plus",
          aliases: ["plus"],
          versions: [
            version({
              from: "2023-02-01",
              default_reference: { tokens_per_1pct: vector(10), source: "curated" },
            }),
          ],
        },
        {
          plan_id: "codex-pro-20x",
          label: "Pro (20x)",
          aliases: ["pro-20x"],
          versions: [version({ from: "2024-12-05" })],
        },
      ]),
    ]);
    const plus = resolveDefaultReference(withVector, "codex", "codex-plus", "2024-12-05");
    const pro = resolveDefaultReference(withVector, "openai", "codex-pro-20x", "2024-12-05");
    expect(plus.kind).toBe("present");
    expect(pro).toEqual({
      kind: "absent",
      reason: "not measured",
      version_from: "2024-12-05",
      version_id: "2024-12-05",
    });
  });
});
describe("null price", () => {
  it("means unverified, never free", () => {
    const catalog = catalogOf([
      openaiGroup([
        {
          plan_id: "mystery",
          label: "Mystery",
          versions: [version({ from: null, usd_per_month: null })],
        },
      ]),
    ]);
    const resolved = resolvePlanVersion(catalog, "codex", "mystery", "2026-01-01");
    expect(resolved.kind).toBe("ok");
    if (resolved.kind === "ok") expect(resolved.version.usd_per_month).toBeNull();
  });
});
describe("validation", () => {
  it("rejects a duplicate plan_id and names the Plan", () => {
    const errors = validatePlansCatalog(
      catalogOf([
        openaiGroup([
          { plan_id: "codex-plus", label: "Plus", versions: [version({ from: "2023-02-01" })] },
          { plan_id: "codex-plus", label: "Plus", versions: [version({ from: "2024-01-01" })] },
        ]),
      ])
    );
    expect(errors.some((e) => e.includes("Plus (codex-plus)") && e.includes("zduplikowany"))).toBe(true);
  });
  it("rejects a non-first version without from and names the Plan", () => {
    const errors = validatePlansCatalog(
      catalogOf([
        openaiGroup([
          {
            plan_id: "codex-plus",
            label: "Plus",
            versions: [version({ from: "2023-02-01" }), version({ from: null })],
          },
        ]),
      ])
    );
    expect(errors.some((e) => e.includes("Plus (codex-plus)") && e.includes("from"))).toBe(true);
  });
  it("rejects colliding version start dates and names the Plan", () => {
    const errors = validatePlansCatalog(
      catalogOf([
        openaiGroup([
          {
            plan_id: "codex-plus",
            label: "Plus",
            versions: [version({ from: "2024-01-01" }), version({ from: "2024-01-01", usd_per_month: 25 })],
          },
        ]),
      ])
    );
    expect(errors.some((e) => e.includes("Plus (codex-plus)") && e.includes("zderzenie"))).toBe(true);
  });
});
describe("plan match", () => {
  it("resolves period values by alias or plan id, including OpenAI's observed pro as Pro (20x)", () => {
    const shipped = loadPlansCatalog(REPO);
    const plan = (provider: string, value: string) => {
      const match = matchPlanAlias(shipped, provider, value);
      return match.kind === "ok" ? match.plan_id : match.reason;
    };
    expect(plan("codex", "PLUS")).toBe("codex-plus");
    expect(plan("openai", "pro")).toBe("codex-pro-20x");
    expect(plan("codex", "prolite")).toBe("codex-pro-5x");
    expect(plan("codex", "codex-pro-5x")).toBe("codex-pro-5x");
    // Labels are display text, not names a period can carry.
    expect(plan("codex", "Pro (20x)")).toBe("no_match");
  });
  it("keeps an ambiguous name explicitly unassigned", () => {
    const catalog = catalogOf([
      openaiGroup([
        { plan_id: "a", label: "Plus", aliases: ["plus"], versions: [version({ from: null })] },
        { plan_id: "plus", label: "Other", versions: [version({ from: null })] },
      ]),
    ]);
    const result = matchPlanAlias(catalog, "codex", "plus");
    expect(result.kind).toBe("unassigned");
    if (result.kind === "unassigned") expect(result.reason).toBe("ambiguous_match");
  });
});
describe("local write / default_reference publication", () => {
  it("lets a local price edit through and overlays the published reference on read", () => {
    const published = loadPlansCatalog(REPO);
    const incoming = stripDefaultReferences(published);
    const plus = incoming.provider_groups[0]!.plans[0]!.versions[0]!;
    plus.usd_per_month = 21;
    const prepared = prepareLocalCatalogWrite(incoming, published);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const dir = tmpDir();
    savePlansCatalog(dir, stripDefaultReferences(prepared.catalog));
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "plans-catalog.json"), "utf-8")) as PlansCatalog;
    expect(stored.provider_groups[0]!.plans[0]!.versions[0]!.default_reference).toBeUndefined();
    expect(stored.provider_groups[0]!.plans[0]!.versions[0]!.usd_per_month).toBe(21);
    const overlaid = overlayPublishedReferences(stored, published);
    expect(overlaid.provider_groups[0]!.plans[0]!.versions[0]!.usd_per_month).toBe(21);
    expect(overlaid.provider_groups[0]!.plans[0]!.versions[0]!.default_reference).toEqual(
      published.provider_groups[0]!.plans[0]!.versions[0]!.default_reference
    );
    expect(fs.existsSync(path.join(REPO, "plans-catalog.json"))).toBe(true);
  });
  it("attempted API mutation of default_reference is refused and does not write", async () => {
    const published = loadPublishedCatalog();
    const incoming = loadPlansCatalog(REPO);
    incoming.provider_groups[0]!.plans[0]!.versions[0]!.default_reference = {
      tokens_per_1pct: vector(1),
      source: "forged",
    };
    const prepared = prepareLocalCatalogWrite(incoming, published);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toContain("default_reference");
    const ctx = { plansCatalog: published } as AppContext;
    const res = await handlePlansCatalogSave(
      ctx,
      new Request("http://local/api/plans-catalog", {
        method: "POST",
        body: JSON.stringify(incoming),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("default_reference");
    expect(ctx.plansCatalog).toBe(published);
  });
  it("GET /api/plans-catalog exposes groups, plans, versions and read-only references", () => {
    const catalog = loadPlansCatalog(REPO);
    const res = handlePlansCatalog({ plansCatalog: catalog } as AppContext);
    expect(res.status).toBe(200);
  });
});
describe("GET body shape", () => {
  it("returns provider groups with versions and default_reference", async () => {
    const catalog = loadPlansCatalog(REPO);
    const res = handlePlansCatalog({ plansCatalog: catalog } as AppContext);
    const body = (await res.json()) as { catalog: PlansCatalog };
    expect(body.catalog.provider_groups.length).toBeGreaterThan(0);
    const plus = body.catalog.provider_groups
      .flatMap((g) => g.plans)
      .find((p) => p.plan_id === "codex-plus");
    expect(plus?.versions[0]?.from).toBe("2023-02-01");
    expect(plus?.versions[0]?.default_reference).toEqual(
      expect.objectContaining({ absent: true, reason: expect.any(String) })
    );
  });
});
describe("load refuses collisions (finding 1)", () => {
  it("validates a file-backed colliding catalog and names the Plan without rewriting", () => {
    const dir = tmpDir();
    const file = path.join(dir, "plans-catalog.json");
    const colliding = catalogOf([
      openaiGroup([
        {
          plan_id: "codex-plus",
          label: "Plus",
          versions: [version({ from: "2024-01-01", usd_per_month: 20 }), version({ from: "2024-01-01", usd_per_month: 25 })],
        },
      ]),
    ]);
    const original = JSON.stringify(colliding, null, 2) + "\n";
    fs.writeFileSync(file, original, "utf-8");
    expect(() => loadPlansCatalog(dir)).toThrow(CatalogValidationError);
    try {
      loadPlansCatalog(dir);
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogValidationError);
      expect((e as CatalogValidationError).message).toContain("Plus (codex-plus)");
      expect((e as CatalogValidationError).message).toContain("zderzenie");
    }
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });
});
describe("POST preserves published reference owners (finding 2)", () => {
  it("rejects an empty or deleted-owner payload and leaves storage unchanged", async () => {
    const published = loadPublishedCatalog();
    const dir = tmpDir();
    const file = path.join(dir, "plans-catalog.json");
    const stored = stripDefaultReferences(published);
    savePlansCatalog(dir, stored);
    const original = fs.readFileSync(file, "utf-8");
    const empty = prepareLocalCatalogWrite({ provider_groups: [] }, published);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/nie może zniknąć|default_reference/);
    const deleted = structuredClone(published);
    deleted.provider_groups[0]!.plans.splice(0, 1);
    const deletedWrite = prepareLocalCatalogWrite(deleted, published);
    expect(deletedWrite.ok).toBe(false);
    if (!deletedWrite.ok) expect(deletedWrite.error).toContain("codex-plus");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    const ctx = { plansCatalog: published } as AppContext;
    const res = await handlePlansCatalogSave(
      ctx,
      new Request("http://local/api/plans-catalog", {
        method: "POST",
        body: JSON.stringify({ catalog: { provider_groups: [] } }),
      })
    );
    expect(res.status).toBe(400);
    expect(ctx.plansCatalog).toBe(published);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });
});
describe("Max weekly cap boundary (finding 3)", () => {
  it("applies weekly caps to both Max plans only from 2025-08-28", () => {
    const shipped = loadPlansCatalog(REPO);
    for (const planId of ["claude-max-5x", "claude-max-20x"] as const) {
      const before = resolvePlanVersion(shipped, "claude", planId, "2025-08-27");
      const on = resolvePlanVersion(shipped, "claude", planId, "2025-08-28");
      expect(before.kind).toBe("ok");
      expect(on.kind).toBe("ok");
      if (before.kind === "ok" && on.kind === "ok") {
        expect(before.version_from).toBe("2025-04-09");
        expect(before.version.limits?.weekly_cap).not.toBe(true);
        expect(on.version_from).toBe("2025-08-28");
        expect(on.version.limits?.weekly_cap).toBe(true);
      }
    }
  });
});
describe("Google Ultra launch price (finding 4)", () => {
  it("resolves launch day as $249.99 and does not assign the unsourced $99.99", () => {
    const shipped = loadPlansCatalog(REPO);
    const launch = resolvePlanVersion(shipped, "gemini", "google-ai-ultra-5x", "2025-05-20");
    expect(launch.kind).toBe("ok");
    if (launch.kind === "ok") {
      expect(launch.version.usd_per_month).toBe(249.99);
      expect(launch.version_from).toBe("2025-05-20");
    }
    const ultra = shipped.provider_groups
      .flatMap((g) => g.plans)
      .find((p) => p.plan_id === "google-ai-ultra-5x");
    expect(ultra?.versions.some((v) => v.usd_per_month === 99.99)).toBe(false);
  });
});
describe("canonical UTC dates (finding 5)", () => {
  it("rejects an impossible date through POST validation", async () => {
    const published = loadPublishedCatalog();
    const incoming = loadPlansCatalog(REPO);
    incoming.provider_groups[0]!.plans[0]!.versions.push({
      from: "2025-02-30",
      usd_per_month: 20,
    });
    const prepared = prepareLocalCatalogWrite(incoming, published);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error).toMatch(/from|YYYY-MM-DD/);
    const ctx = { plansCatalog: published } as AppContext;
    const res = await handlePlansCatalogSave(
      ctx,
      new Request("http://local/api/plans-catalog", {
        method: "POST",
        body: JSON.stringify(incoming),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/from|YYYY-MM-DD/);
    expect(ctx.plansCatalog).toBe(published);
  });
});
describe("atomic save (finding 6)", () => {
  it("leaves original bytes unchanged when the write fails", () => {
    const dir = tmpDir();
    const file = path.join(dir, "plans-catalog.json");
    const original = JSON.stringify({ provider_groups: [] }, null, 2) + "\n";
    fs.writeFileSync(file, original, "utf-8");
    const flush = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk flush failed"); });
    try {
      expect(() => savePlansCatalog(dir, catalogOf([openaiGroup([{ plan_id: "x", label: "X", versions: [version({ from: null })] }])]))).toThrow("disk flush failed");
    } finally { flush.mockRestore(); }
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });
});
