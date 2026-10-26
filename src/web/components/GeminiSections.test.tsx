import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setLanguage } from "../lib/i18n";
import type { RosterCard } from "../lib/roster";
import { geminiSections } from "./GeminiSections";

const spend = {
  anchored: false, since_ts: "2026-08-24T13:38:03.000Z", until_ts: "2026-08-31T13:38:03.000Z", resolution: "conversation",
  generations: 1597, conversations: 6, gross: 229292968, fresh_in: 9340243, cached_in: 219081992, out_total: 870733,
  out_thinking: 388604, usd: 26.09, usd_basis: "api-eq",
  models: [{ model: "gemini-3.7-flash", generations: 1308, tokens: 193823101, fresh: 8089812, usd: 22.04 }],
  first_ts: "2026-08-18T09:48:40.000Z", last_ts: "2026-08-31T13:38:03.000Z", all_time_gross: 402844384, all_time_usd: 43.62,
  unpriced_models: [],
};
const withheld = "Configured Antigravity account; worker does not verify the active login, so quota is withheld to prevent mixing accounts.";
const card = (gemini: object) => ({ id: "gemini-273e6035ff754bd8", vendor: "gemini", gemini } as unknown as RosterCard);
const html = (node: unknown) => renderToStaticMarkup(<>{node as React.ReactNode}</>);

test("a withheld quota keeps the indexed models and traffic and names the reason in place of the limits", () => {
  setLanguage("en");
  const c = card({ profile: "sample_c", ts: "2026-10-08T09:03:52.186Z", age_minutes: 7.7, ok: false, error: withheld,
    windows: [], fingerprint: null, fingerprint_shared_with: [], google: null, port: null, spend });
  const sections = geminiSections({ card: c, pool: [c], onSelect: () => {}, capabilities: null });
  expect(html(sections.models)).toContain("gemini-3.7-flash");
  expect(html(sections.traffic)).not.toContain("no /quota reading");
  const plan = html(sections.planWindows);
  expect(plan).toContain(withheld);
  expect(plan).not.toContain("Account limits");
});

test("an unavailable worker without indexed traffic still empties every section", () => {
  setLanguage("en");
  const c = card({ profile: "agy1", ts: "2026-10-08T09:03:52.186Z", age_minutes: 1, ok: false, error: "worker down",
    windows: [], fingerprint: null, fingerprint_shared_with: [], google: null, port: 7001, spend: null });
  const sections = geminiSections({ card: c, pool: [c], onSelect: () => {}, capabilities: null });
  expect(html(sections.models)).toContain("worker unavailable");
  expect(html(sections.planWindows)).toContain("worker unavailable");
});
