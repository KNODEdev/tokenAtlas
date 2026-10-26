import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import { handleRateCards, handleRateCardsSave, type AppContext } from "./api";
import type { RateCard } from "./pricing";
import { withContextRates } from "./rate-cards-file";
import { vendorContextPremium, vendorHasContextTier } from "./vendor-context-premium";

const card = () => withContextRates(structuredClone(shipped) as unknown as RateCard);

test("the vendor premium is off unless set, and only vendors with tiers offer it", () => {
  const c = card();
  expect(vendorHasContextTier(c, "anthropic")).toBe(true);
  expect(vendorHasContextTier(c, "xai")).toBe(false);
  expect(vendorContextPremium(c, "anthropic")).toBe(false);
  c.vendors.anthropic!.long_context_premium = true;
  expect(vendorContextPremium(c, "anthropic")).toBe(true);
});

test("the rate card read exposes the switch for tiered vendors only; Codex keeps its own setting", async () => {
  const ctx = { rateCards: card(), accounts: { subscriptions: [] }, sqlite: null, subIdToHomes: new Map() } as unknown as AppContext;
  // Without a database the plan column is empty; the vendors are read from the card alone.
  const body = await handleRateCards(ctx).json() as { vendors: Array<{ vendor: string; long_context_premium?: boolean }> };
  expect(body.vendors.find(v => v.vendor === "anthropic")?.long_context_premium).toBe(false);
  expect(body.vendors.find(v => v.vendor === "openai")).not.toHaveProperty("long_context_premium");
});

test("saving the premium is a separate, validated write that never touches other vendors", async () => {
  const ctx = { rateCards: card() } as AppContext;
  const save = (payload: unknown) => handleRateCardsSave(ctx, new Request("http://local/api/rate-cards", { method: "POST", body: JSON.stringify(payload) }));
  for (const payload of [
    { vendor: "anthropic", long_context_premium: "yes" },
    { vendor: "anthropic", model: "claude-haiku-5-5", long_context_premium: true },
    { vendor: "anthropic", rates: { in_uncached: 1 }, long_context_premium: true },
    { vendor: "openai", long_context_premium: true },
    { vendor: "xai", long_context_premium: true },
  ]) expect((await save(payload)).status).toBe(400);
  expect(ctx.rateCards.vendors.anthropic).not.toHaveProperty("long_context_premium");
});
