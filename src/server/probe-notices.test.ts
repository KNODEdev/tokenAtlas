import { expect, test } from "bun:test";
import { probeNotices, type CardHistory } from "./probe-health";
import { DATA_VIEWS, DIRECT_DATA_ROUTES } from "./data-views";

const mark = (id: number, ts: string) => ({ id, at: Date.parse(ts), ts });
const EXPIRED = "[login-expired] Claude sign-in expired: the token refresh was refused (invalid_grant, HTTP 400); run `claude` and sign in (/login).";

function card(subject: string, machines: CardHistory["health"]["machines"]): [string, CardHistory] {
  return [subject, { provider: "claude", subject, activity: { first: null, last: null }, health: { success: null, machines } }];
}

test("a coded failure newer than the machine's last success is a notice; anything else is not", () => {
  const cards = new Map([
    card("claude-1", {
      [JSON.stringify("EXAMPLE-LAPTOP-A")]: { lo: 0, hi: 0, ok: mark(1, "2026-10-09T01:19:00Z"), err: { ...mark(2, "2026-10-09T13:50:00Z"), error: EXPIRED } },
      // Recovered after the failure.
      [JSON.stringify("EXAMPLE-MAIN")]: { lo: 0, hi: 0, ok: mark(4, "2026-10-09T13:55:00Z"), err: { ...mark(3, "2026-10-09T13:50:00Z"), error: EXPIRED } },
      // An uncoded failure stays a diagnostic.
      [JSON.stringify("OTHER")]: { lo: 0, hi: 0, ok: null, err: { ...mark(5, "2026-10-09T13:50:00Z"), error: "HTTP 500" } },
    }),
    card("claude-2", {
      [JSON.stringify(null)]: { lo: 0, hi: 0, ok: null, err: { ...mark(6, "2026-10-09T12:00:00Z"), error: "[login-mismatch] Claude OAuth identity does not match" } },
    }),
  ]);
  // Ordered by vendor, then by the account's name (its id when unnamed), then by computer.
  expect(probeNotices(cards, (_provider, subject) => subject === "claude-1" ? "one@example.com" : null)).toEqual([
    { provider: "claude", subject: "claude-2", account: null, machine: null, code: "login-mismatch", since: null, failed_at: "2026-10-09T12:00:00Z" },
    { provider: "claude", subject: "claude-1", account: "one@example.com", machine: "EXAMPLE-LAPTOP-A", code: "login-expired",
      since: "2026-10-09T01:19:00Z", failed_at: "2026-10-09T13:50:00Z" },
  ]);
});

test("the notices route reads stored rows and is declared as such", () => {
  expect(DATA_VIEWS["/api/probe-notices"]).toBeUndefined();
  expect(DIRECT_DATA_ROUTES["/api/probe-notices"]).toContain("stored rows");
});
