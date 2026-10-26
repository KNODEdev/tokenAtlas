import { afterEach, expect, test } from "bun:test";
import { creditNoticeOccurredAt, type CreditNoticeView } from "../../shared/credit-notices";
import { creditNoticeAlert, creditNoticeLine, creditNoticeSuffix, timeLeft } from "./credit-notices";
import { setLanguage } from "./i18n";

const DAY = 86_400_000;
const now = Date.parse("2026-10-24T12:00:00Z");
let nextId = 1;
const notice = (fields: Partial<CreditNoticeView> & Pick<CreditNoticeView, "kind" | "unit">): CreditNoticeView => {
  const row = { id: nextId++, provider: "claude", account: "max-1", label: "Claude Max", pool: "claude:iguana_necktie@2026-11-05T00:00:00.000Z",
    amount: null, amount_text: null, expires_at: null, observed_at: "2026-10-24T10:00:00Z", detail: {},
    acknowledged_at: null, resolved_at: null, ...fields };
  return { ...row, occurred_at: fields.occurred_at ?? creditNoticeOccurredAt(row) };
};

const grantWarning = notice({ kind: "expiring", unit: "usd", amount: 150, expires_at: "2026-11-05T12:00:00Z",
  detail: { stage: "14d", granted: 250, remaining: 200, pace_per_day: 5, days_left: 12 } });
const resetWarning = notice({ kind: "expiring", unit: "resets", amount: 1, provider: "codex", label: "Codex Pro", pool: "codex:resets",
  expires_at: "2026-10-26T09:14:00Z", detail: { title: "Full reset", granted_at: "2026-09-26T09:14:00Z" } });
const grantReceived = notice({ kind: "received", unit: "usd", amount: 250, expires_at: "2026-11-05T12:00:00Z", observed_at: "2026-10-06T08:00:00Z" });
const resetReceived = notice({ kind: "received", unit: "resets", amount: 1, provider: "codex", label: "Codex Pro", pool: "codex:resets",
  expires_at: "2026-11-08T10:02:00Z", detail: { title: "Full reset", granted_at: "2026-10-09T10:02:00Z" } });
const creditsSpent = notice({ kind: "spent", unit: "credits", amount: 1234.5, amount_text: "1234.5", provider: "codex", label: "Codex Pro",
  pool: "codex:credits", detail: { remaining: 60749.9557035, remaining_text: "60749.9557035", since: "2026-10-06T08:00:00Z" } });

afterEach(() => setLanguage("en"));

test("lines in Polish name the subscription, the amount and the date", () => {
  setLanguage("pl");
  expect(creditNoticeLine(grantWarning, now)).toEqual({ tone: "warn", title: "Wygaśnie niewykorzystany",
    detail: "Claude Max · grant $250 · zostało $200 · zużycie $5/dzień · ok. $150 przepadnie 5 lis",
    facts: "grant $250 · zostało $200 · zużycie $5/dzień · ok. $150 przepadnie 5 lis", when: null });
  expect(creditNoticeLine(grantReceived, now)).toMatchObject({ tone: "ok", title: "Nowy pakiet",
    facts: "grant $250, ważny do 5 lis", when: `otrzymany ${new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short" }).format(new Date(grantReceived.occurred_at))} ${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(grantReceived.occurred_at))}` });
  expect(creditNoticeLine(resetReceived, now).detail).toStartWith("Codex Pro · pełny reset limitów, ważny do 8 lis · otrzymany 9 paź");
  expect(creditNoticeLine(creditsSpent, now)).toMatchObject({ tone: "info", title: "Zużyto kredyty",
    facts: "−1234,5 kredytów od 6 paź · saldo 60 749,96 kredytów" });
  expect(creditNoticeLine(creditsSpent, now).when).toBeTruthy();
});

test("a grant without a day of observation says its pace is not known yet", () => {
  const line = creditNoticeLine({ ...grantWarning, detail: { ...grantWarning.detail, pace_per_day: null }, amount: 200 }, now);
  expect(line.detail).toContain("pace not known yet");
  expect(creditNoticeAlert([{ ...grantWarning, detail: { ...grantWarning.detail, pace_per_day: null } }], now)!.detail)
    .toBe("Claude Max: $200 left, expires Nov 5 (in 12 days)");
});

test("the status line warns about the soonest expiry and counts the rest; arrivals never take it", () => {
  setLanguage("pl");
  expect(creditNoticeAlert([grantWarning, resetWarning, grantReceived], now)).toEqual({ title: "Reset limitów wygaśnie niewykorzystany",
    detail: `Codex Pro: wygasa ${new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "short" }).format(new Date(resetWarning.expires_at!))} `
      + `${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(resetWarning.expires_at!))} (za 2 dni) · +1 więcej` });
  expect(creditNoticeAlert([grantWarning], now)).toEqual({ title: "Pakiet wygaśnie niewykorzystany",
    detail: "Claude Max: przy obecnym tempie ok. $150 z $200 przepadnie 5 lis (za 12 dni)" });
  expect(creditNoticeAlert([grantReceived, creditsSpent], now)).toBeNull();
});

test("arrivals extend the current-data line", () => {
  setLanguage("pl");
  expect(creditNoticeSuffix([grantReceived, resetReceived, creditsSpent])).toBe("nowe pakiety: 2 (Claude Max $250, Codex Pro 1 reset)");
  expect(creditNoticeSuffix([grantReceived])).toBe("nowy pakiet: Claude Max $250");
  expect(creditNoticeSuffix([creditsSpent])).toBeNull();
});

test("time left is in days, under a day in hours", () => {
  expect(timeLeft(new Date(now + 12 * DAY).toISOString(), now)).toBe("in 12 days");
  expect(timeLeft(new Date(now + 5 * 3_600_000).toISOString(), now)).toBe("in 5 h");
});

test("read and resolved history never raises current warnings or arrival summaries", () => {
  const history = [{ ...grantWarning, resolved_at: "2026-10-24T11:00:00Z" },
    { ...resetWarning, acknowledged_at: "2026-10-24T11:00:00Z" },
    { ...grantReceived, acknowledged_at: "2026-10-24T11:00:00Z" }];
  expect(creditNoticeAlert(history, now)).toBeNull();
  expect(creditNoticeSuffix(history)).toBeNull();
  expect(creditNoticeAlert([...history, resetWarning], now)!.title).toBe("A limit reset will expire unused");
  expect(creditNoticeSuffix([...history, grantReceived])).toBe("new package: Claude Max $250");
});
