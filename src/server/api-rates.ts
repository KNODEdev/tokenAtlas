import type { CodexSpeedEdit } from "./codex-accounting-pricing";
import { configWriteTarget } from "../config/paths";
import type { RateCard, VendorCard, ModelRateAny } from "./pricing";
import fs from "fs";
import { prepareCodexLedgerModelEdit, codexLedgerModelSpeed } from "./codex-ledger-model-editor";
import { atomicArchiveWrite } from "../sync/archive-publication";
import type { AppContext } from "./app-context-types";
import type { PeriodIndex } from "./account-periods";
import { planPeriodIndex } from "./account-periods";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { nextDay } from "./api-request-params";
import { withContextRates } from "./rate-cards-file";
import { vendorContextPremium, vendorHasContextTier } from "./vendor-context-premium";

const EDITABLE_RATE_KEYS = [
  "in_uncached",
  "in_cache_read",
  "in_cache_write",
  "in_cache_write_5m",
  "in_cache_write_1h",
  "out_total",
] as const;

export async function handleRateCardsSave(ctx: AppContext, req: Request): Promise<Response> {
  let body: { vendor?: string; model?: string; rates?: Record<string, number | null>; codex_speed?: CodexSpeedEdit; long_context_premium?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const vendor = typeof body?.vendor === "string" ? body.vendor.trim().toLowerCase() : null;
  if (body?.long_context_premium !== undefined) return saveVendorContextPremium(ctx, vendor, body);
  const model = typeof body?.model === "string" ? body.model.trim() : null;
  if (!vendor || !model) {
    return Response.json({ error: "potrzebne `vendor` i `model`" }, { status: 400 });
  }
  const entries = Object.entries(body.rates ?? {});
  if (entries.length === 0 && body.codex_speed === undefined) {
    return Response.json({ error: "potrzebne `rates` z co najmniej jedną stawką" }, { status: 400 });
  }
  for (const [key, value] of entries) {
    if (!(EDITABLE_RATE_KEYS as readonly string[]).includes(key)) {
      return Response.json({ error: `nieznane pole stawki: ${key}` }, { status: 400 });
    }
    if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000)) {
      return Response.json(
        { error: `${key}: stawka musi być liczbą 0..100000 USD za 1M tokenów albo null ("nie wyceniamy")` },
        { status: 400 }
      );
    }
  }
  if (!ctx.rateCards.vendors[vendor]) {
    return Response.json(
      { error: `nieznany vendor '${vendor}' - cennik zna: ${Object.keys(ctx.rateCards.vendors).join(", ")}` },
      { status: 400 }
    );
  }
  const path = configWriteTarget("rate-cards.json");
  let next: RateCard;
  try {
    next = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) as RateCard : structuredClone(ctx.rateCards);
    if (body.codex_speed !== undefined && vendor !== "openai") throw new Error("Mnożniki Codex dotyczą modeli OpenAI");
    if (vendor === "openai") next = prepareCodexLedgerModelEdit(next, model, {
      rates: body.rates, speed: body.codex_speed, day: new Date().toISOString().slice(0, 10),
    }).card;
    if (!next.vendors[vendor]) throw new Error(`nieznany vendor '${vendor}' w bieżącym cenniku`);
  } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  const vendorCard = next.vendors[vendor]!;
  vendorCard.models = vendorCard.models ?? {};
  const target = (vendorCard.models[model] ?? {}) as Record<string, unknown>;
  const rateTarget = vendor === "openai" && typeof target.until === "string" && target.until < new Date().toISOString().slice(0, 10)
    && target.after && typeof target.after === "object" ? target.after as Record<string, unknown> : target;
  for (const [key, value] of entries) rateTarget[key] = value;
  (vendorCard.models as Record<string, unknown>)[model] = target;
  try {
    atomicArchiveWrite(path, JSON.stringify(next, null, 2) + "\n");
  } catch (e) {
    return Response.json(
      { error: `zapis ${path} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
  // The context tiers live in their own file; the card in memory carries them, as a fresh load would.
  ctx.rateCards = withContextRates(next);
  return handleRateCards(ctx);
}

/**
 * The vendor's long-context premium, saved alone (Codex keeps its own in Codex prices). On applies the models'
 * long-context rates in every API value; off (absent) values at base rates. The ledger revalues the long requests.
 */
function saveVendorContextPremium(ctx: AppContext, vendor: string | null, body: { model?: string; rates?: unknown; codex_speed?: unknown; long_context_premium?: unknown }): Response {
  if (typeof body.long_context_premium !== "boolean" || body.model !== undefined || body.rates !== undefined || body.codex_speed !== undefined) {
    return Response.json({ error: "Zmiana dopłaty za długi kontekst jest osobnym zapisem: tylko `vendor` i `long_context_premium`." }, { status: 400 });
  }
  if (!vendor || vendor === "openai" || !vendorHasContextTier(ctx.rateCards, vendor)) {
    return Response.json({ error: `'${vendor ?? ""}' nie ma stawek długiego kontekstu w tym cenniku` }, { status: 400 });
  }
  const path = configWriteTarget("rate-cards.json");
  let next: RateCard;
  try {
    next = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) as RateCard : structuredClone(ctx.rateCards);
    if (!next.vendors[vendor]) throw new Error(`nieznany vendor '${vendor}' w bieżącym cenniku`);
  } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  const vendorCard = next.vendors[vendor]!;
  // Absent is the default (off), so turning it off leaves no flag behind.
  if (body.long_context_premium) vendorCard.long_context_premium = true; else delete vendorCard.long_context_premium;
  try {
    atomicArchiveWrite(path, JSON.stringify(next, null, 2) + "\n");
  } catch (e) {
    return Response.json({ error: `zapis ${path} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  ctx.rateCards = withContextRates(next);
  return handleRateCards(ctx);
}

export function handleRateCards(ctx: AppContext): Response {
  const card = ctx.rateCards;
  const vendors = Object.entries(card.vendors)
    .filter((entry): entry is [string, VendorCard] => entry[1] != null)
    .map(([vendor, v]) => {
      const models = Object.entries(v.models || {}).map(([model, r]) => {
        const modelSpeed = vendor === "openai" ? codexLedgerModelSpeed(card, model, new Date().toISOString().slice(0, 10)) : undefined;
        const variants: Array<{
          kind: "period" | "mode";
          label: string;
          from: string | null;
          until: string | null;
          rates: Record<string, number>;
        }> = [];
        const pick = (o: ModelRateAny | Record<string, number | undefined>): Record<string, number> => {
          const src = o as Record<string, unknown>;
          const out: Record<string, number> = {};
          for (const key of ["in_uncached", "in_cache_read", "in_cache_write", "in_cache_write_5m", "in_cache_write_1h", "out_total"]) {
            const value = src[key];
            if (typeof value === "number") out[key] = value;
          }
          return out;
        };
        variants.push({
          kind: "period",
          label: r.until ? `do ${r.until}` : "bez zmian",
          from: null,
          until: r.until ?? null,
          rates: pick(r),
        });
        if (r.until && r.after) {
          variants.push({
            kind: "period",
            label: `od ${nextDay(r.until)}`,
            from: nextDay(r.until),
            until: null,
            rates: pick(r.after),
          });
        }
        const datedStandard = modelSpeed?.rules.filter(rule => rule.speed === "standard" && rule.billing_basis === "api_equivalent_usd") ?? [];
        if (datedStandard.length) {
          variants.length = 0;
          for (const rule of datedStandard.toSorted((a,b) => a.valid_from.localeCompare(b.valid_from))) {
            const until = rule.valid_until ? new Date(Date.parse(rule.valid_until) - 86400000).toISOString().slice(0, 10) : null;
            variants.push({ kind: "period", label: `od ${rule.valid_from}${until ? ` do ${until}` : ""}`, from: rule.valid_from, until, rates: pick(rule.rates) });
          }
        }
        const currentDay = new Date().toISOString().slice(0, 10);
        const fast = modelSpeed?.rules.find(rule => rule.speed === "fast" && rule.billing_basis === "api_equivalent_usd"
          && rule.valid_from <= currentDay && (!rule.valid_until || currentDay < rule.valid_until))?.rates ?? r.fast;
        if (fast) {
          const rates = pick(fast);
          variants.push({
            kind: "mode",
            label: "fast mode",
            from: null,
            until: null,
            rates,
          });
        }
        return {
          model,
          note: r.note ?? null,
          confidence: r.confidence ?? null,
          proxy_for: r.proxy_for ?? null,
          priced: typeof r.in_uncached === "number",
          variants,
          codex_speed: modelSpeed,
        };
      });
      return {
        vendor,
        verified: v.verified ?? false,
        source: v.source ?? null,
        notes: v.notes ?? [],
        day_scoped: vendor === "anthropic" || vendor === "openai",
        // Codex prices its premium in Codex prices; other vendors with tiered models have this switch.
        ...(vendor !== "openai" && vendorHasContextTier(card, vendor) ? { long_context_premium: vendorContextPremium(card, vendor) } : {}),
        model_count: models.length,
        models: models.sort((a, b) => a.model.localeCompare(b.model)),
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor));
  const declared = ctx.accounts.subscriptions || [];
  // The plan column is the account's plan now, from its plan periods (declared over observed).
  let planIndex: PeriodIndex | null = null;
  try { planIndex = planPeriodIndex(loadPeriods(ctx.sqlite, PLAN_PERIODS)); }
  catch (error) { console.warn("[rate-cards] plan periods unreadable:", error instanceof Error ? error.message : error); }
  const nowIso = new Date().toISOString();
  const subscriptions = Object.entries(card.subscriptions || {})
    .filter(([id]) => !id.startsWith("_") && id.toLowerCase() !== "claude")
    .map(([id, sub]) => {
      const account = declared.find((a) => a.id.toLowerCase() === id.toLowerCase()) ?? null;
      const homes = ctx.subIdToHomes.get(id.toLowerCase()) || [];
      const periodVendor = account?.vendor === "openai" ? "codex" : account?.vendor ?? (id.startsWith("codex") ? "codex" : "");
      return {
        id,
        plan: planIndex?.resolve(periodVendor, id, nowIso).value ?? null,
        usd_per_month: sub.usd_per_month ?? null,
        confidence: sub.confidence ?? null,
        vendor: account?.vendor ?? (id.startsWith("codex") ? "openai" : null),
        rate_vendor: id.startsWith("codex") ? "openai" : account?.vendor ?? null,
        declared_in_accounts: account != null,
        home_count: homes.length,
        note: account?.note ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const monthlyTotal = subscriptions.reduce((a, s) => a + (s.usd_per_month ?? 0), 0);
  return Response.json({
    version: card.version,
    currency: card.currency,
    unit: card.unit,
    subscriptions,
    monthly_total_usd: monthlyTotal,
    vendors,
  });
}
