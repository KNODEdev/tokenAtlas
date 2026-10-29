import { expect, test } from "bun:test";
import { pendingNotice } from "./BillingCycles";

const pl = (_english: string, polish: string) => polish;
const notice = (pending: Parameters<typeof pendingNotice>[0]["pending"], stale = true) => pendingNotice({ stale, pending }, pl, "pl-PL");

test("only a change that can move dates or prices gets a sentence; new readings get a tooltip only", () => {
  expect(notice(null, false)).toBeNull();
  expect(notice({ reason: "periods", from: "2026-09-16T00:00:00.000Z" })?.text).toBe("Przeliczam od 16.09 — daty i ceny mogą się zmienić.");
  expect(notice({ reason: "rules", from: null })?.text).toBe("Przeliczam cykle według nowych zasad — daty i ceny mogą się zmienić.");
  expect(notice({ reason: "rollover", from: "2026-11-21T17:30:00.000Z" })?.text).toBe("Nowy cykl od 21.11 — dodaję go.");
  const figures = notice({ reason: "figures", from: null });
  expect(figures?.text).toBeNull();
  expect(figures?.title).toBe("Nowe odczyty — liczby odświeżą się za chwilę; daty cykli się nie zmienią.");
  // A server without `pending` keeps the former sentence.
  expect(notice(undefined)?.text).toBe("Aktualizacja w tle — liczby mogą się zaraz zmienić.");
});
