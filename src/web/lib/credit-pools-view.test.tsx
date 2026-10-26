import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CreditPoolState, CreditPoolsOfRange, CreditPoolFlow } from "../../shared/credit-pools";
import { codexPoolEvidence } from "../../shared/pool-usage";
import type { CreditFundedSums, CreditWindowBasis } from "../../shared/credit-funded";
import { accountCredits, creditCardView, creditStripView, windowCreditRows, creditTag, railCreditsView, windowsText, compactCredits, exactDecimal } from "./credit-pools-view";
import { PoolFacts } from "../components/PoolFacts";
import { setLanguage } from "./i18n";

const pool = (fields: Partial<CreditPoolState>): CreditPoolState => ({ key: "grant", kind: "grant", unit: "usd", granted: 250, used: 8.1,
  remaining: 241.9, remaining_text: null, unlimited: false, granted_at: null, expires_at: null, items: null, ...fields });
const grant = pool({ key: "claude:grant", expires_at: "2026-11-05T12:00:00Z" });
const balance = pool({ key: "codex:credits", kind: "balance", unit: "credits", granted: null, used: null, remaining: 60749.9557035, remaining_text: "60749.9557035000" });
const resets = pool({ key: "codex:resets", kind: "resets", unit: "resets", granted: null, used: null, remaining: 3, expires_at: "2026-10-22T10:00:00Z", items: [] });
const range = (pools: CreditPoolState[], flows: CreditPoolFlow[] = []): CreditPoolsOfRange => ({ read_at: "2026-10-10T07:31:00Z", pools, flows });
const flow = (key: string, spent: number, unit: CreditPoolFlow["unit"] = "usd"): CreditPoolFlow => ({ key, unit, since: "2026-10-09T08:00:00Z", start_remaining: null, end_remaining: null, spent, added: 0, expired: 0 });
const basis: CreditWindowBasis = { start: "2026-09-26T16:58:00Z", end: "2026-10-03T09:22:00Z", credits: 39061.54, usd: 2065.4, tokens: 4.78e9, partial: false };
const funded: CreditFundedSums = { calls: 3127, tokens: 549e6, credits: 4500, credits_unpriced: 0, api_standard: 238, api_unpriced: 0,
  first: "2026-10-01T08:00:00Z", last: "2026-10-02T20:00:00Z", hours: [] };
afterEach(() => setLanguage("en"));

describe("one pool presentation", () => {
  test("no pools or empty resets alone add no block", () => {
    expect(accountCredits(null)).toBeNull(); expect(accountCredits(range([]))).toBeNull();
    expect(accountCredits(range([{ ...resets, remaining: 0 }]))).toBeNull();
    expect(creditCardView(range([]), null)).toBeNull();
  });
  test("credit balance conversion retains the measured basis and exact balance", () => {
    const account = accountCredits(range([balance, resets]), basis)!;
    expect(account.windows).toBeCloseTo(balance.remaining! / basis.credits, 9);
    expect(account.usd).toBeCloseTo(balance.remaining! * basis.usd! / basis.credits, 6);
    expect(account.resets?.count).toBe(3);
    expect(accountCredits(range([balance]), null)?.windows).toBeNull();
    expect(accountCredits(range([balance]), { ...basis, usd: null })?.usd).toBeNull();
    expect(creditCardView(range([balance]), basis)?.title).toContain("60,749.9557035");
  });
  test("Codex and Claude use the same view fields and the same PoolFacts component", () => {
    for (const source of [balance, grant]) {
      const card = creditCardView(range([source]), source.unit === "credits" ? basis : null)!;
      const strip = creditStripView(accountCredits(range([source]), source.unit === "credits" ? basis : null))!;
      expect(card.pools).toEqual(strip.pools);
      expect(card.pools[0]?.key).toBe(source.key);
      const html = renderToStaticMarkup(<PoolFacts pool={card.pools[0]!} compact />);
      expect(html).toContain(`data-pool="${source.key}"`);
      expect(html).toContain("sub-card-pool-bar");
      expect(html).not.toContain("data-dollar-pool");
    }
  });
  test("credit conversion is a balance bar, with no invented granted or lifetime-used amount", () => {
    const view = creditCardView(range([balance]), basis)!.pools[0]!;
    expect(view.bar).toBeCloseTo(balance.remaining! / basis.credits / 2, 9);
    expect(view.summary).toBe(""); expect(view.aside).toContain("1.6 windows");
    expect(creditCardView(range([balance]), null)!.pools[0]!.bar).toBeNull();
  });
  test("an exhausted grant shows granted 250, used 250 and remaining zero", () => {
    setLanguage("pl");
    const view = creditCardView(range([{ ...grant, used: 250, remaining: 0 }]), null)!.pools[0]!;
    expect(view.summary).toBe("przyznano $250,00 · zużyto $250,00");
    expect(view.remaining).toBe("zostało $0,00"); expect(view.bar).toBe(0); expect(view.aside).toBe("wygasa 05.11");
  });
  test("missing values remain independent, including zero and inconsistent provider facts", () => {
    const unknown = creditCardView(range([{ ...grant, used: null }]), null)!.pools[0]!;
    expect(unknown.summary).toBe("granted $250.00 · used not established");
    expect(unknown.remaining).toBe("left $241.90");
    const noBalance = creditCardView(range([{ ...grant, granted: null, used: 0, remaining: null }]), null)!.pools[0]!;
    expect(noBalance.summary).toBe("granted not established · used $0.00");
    expect(noBalance.remaining).toBe("left not established"); expect(noBalance.bar).toBeNull();
    expect(creditCardView(range([{ ...grant, used: 250.01, remaining: 0 }]), null)!.pools[0]!.summary).toContain("250.01");
  });
  test("grant, purchase and separate grant identities never merge", () => {
    const purchase = pool({ key: "claude:spend", kind: "purchase", granted: 100, used: 25, remaining: 75 });
    const second = pool({ key: "claude:another", granted: 50, used: null, remaining: 40 });
    const views = creditCardView(range([grant, purchase, second]), null)!.pools;
    expect(views.map(view => view.key)).toEqual([grant.key, purchase.key, second.key]);
    expect(views[1]!.summary).toBe("limit $100.00 · used $25.00");
    expect(views[2]!.summary).toBe("granted $50.00 · used not established");
  });
  test("observed charges and valued funded calls are separate on both the model and description", () => {
    const source = range([balance], [flow(balance.key, 49.4557035, "credits")]);
    const card = creditCardView(source, basis, { usedPercent: 100, creditFunded: funded })!;
    expect(card.pools[0]?.observedSpend).toContain("49.46 cr");
    expect(card.pools[0]?.fundedValue).toContain("4,500 cr");
    const account = accountCredits(source, basis, codexPoolEvidence(funded))!;
    expect(account.pools[0]!.observedSpend).toBe(49.4557035); expect(account.pools[0]!.funded?.native).toBe(4500);
    const missingCharge = creditCardView(range([balance]), null, { usedPercent: 100, creditFunded: funded })!.pools[0]!;
    expect(missingCharge.observedSpend).toBeNull(); expect(missingCharge.fundedValue).not.toBeNull();
  });
  test("resets retain their count, expiry and no imaginary money balance", () => {
    const card = creditCardView(range([resets]), null)!;
    expect(card.pools).toEqual([]); expect(card.resets).toMatchObject({ dots: 3, left: "3 free resets" });
    expect(creditStripView(accountCredits(range([resets])))?.resets).toContain("3 free resets");
  });
  test("observed zero differs from no observation and from lifetime use", () => {
    const rows = (pools: CreditPoolsOfRange) => windowCreditRows({ funded: null, windowTokens: null, pools, account: accountCredits(pools) });
    expect(rows(range([grant]))).toBeNull();
    const observed = rows(range([grant], [flow(grant.key, 0)]))!;
    expect(observed[0]).toMatchObject({ label: "grant · this window", value: "$0.00", detail: null });
    expect(observed[0]!.title).toContain("2026-10-09T08:00:00Z");
    expect(rows(range([], [flow("gone", 12)]))![0]!.label).toBe("dollar pool · this window");
  });
  test("known funded calls and tokens remain available without inventing grant-funded calls", () => {
    const creditRows = windowCreditRows({ funded, windowTokens: 4.78e9, pools: null, account: null })!;
    expect(creditRows[0]).toMatchObject({ label: "from credits", value: "3,127" });
    expect(creditRows[0]!.detail).toContain("549M tokens");
    const grantRows = windowCreditRows({ funded: null, windowTokens: null, pools: range([grant], [flow(grant.key, 7.923)]), account: accountCredits(range([grant])) })!;
    expect(grantRows[0]!.value).toBe("$7.92"); expect(grantRows[0]!.detail).toBeNull();
  });
  test("credit tags and rail conversion retain the existing values", () => {
    setLanguage("pl");
    expect(creditTag(funded)?.text).toBe("+4,5k kr."); expect(creditTag(null)).toBeNull();
    expect(railCreditsView(accountCredits(range([balance, resets]), basis), [funded, { ...funded, credits: 500 }])).toMatchObject({ balance: "60 750", used: "5000", resets: "3 resety" });
    expect(railCreditsView(accountCredits(range([grant])), [])).toBeNull();
  });
  test("shared formatters retain exact decimal text and Polish plurals", () => {
    setLanguage("pl");
    expect([windowsText(1), windowsText(2), windowsText(5), windowsText(1.55)]).toEqual(["1 okno", "2 okna", "5 okien", "1,6 okna"]);
    expect([compactCredits(950), compactCredits(4500), compactCredits(125000)]).toEqual(["950 kr.", "+4,5k kr.".slice(1), "125k kr."]);
    expect(exactDecimal("60749.9557035000")).toBe("60 749,9557035");
    setLanguage("en"); expect(exactDecimal("60749.9557035000")).toBe("60,749.9557035");
  });
});
