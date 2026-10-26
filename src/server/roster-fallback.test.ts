import { expect, test } from "bun:test";
import { createRosterFallback } from "./roster-fallback";

const KEY = "/api/roster?window=10080";
const roster = (accounts: unknown[], preparing?: Array<{ vendor: string; id: string | null }>) =>
  Response.json({ window_minutes: 10080, count: accounts.length, accounts, ...(preparing ? { preparing_accounts: preparing } : {}) });
const preparingReceipt = () => Response.json({ status: "preparing" }, { status: 202, headers: { "X-Analysis": "preparing", "X-Analysis-Poll-Ms": "100" } });
const card = (vendor: string, id: string, value: number) => ({ id, vendor, value });
const placeholder = (vendor: string, id: string) => ({ id, vendor, value: null, preparing: true });

function clock() {
  let at = 1_000;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test("a ready roster passes through unchanged and is not marked stale", async () => {
  const fallback = createRosterFallback();
  const response = await fallback.respond(KEY, "db", roster([card("codex", "codex1", 1)]));
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Analysis")).toBeNull();
  expect(await response.json()).toMatchObject({ accounts: [card("codex", "codex1", 1)] });
});

test("a preparing roster answers the last ready roster, marked stale with its build time", async () => {
  const time = clock();
  const fallback = createRosterFallback(time.now);
  await fallback.respond(KEY, "db", roster([card("codex", "codex1", 1), card("claude", "claude1", 2)]));
  time.advance(5_000);
  const response = await fallback.respond(KEY, "db", preparingReceipt());
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Analysis")).toBe("stale");
  expect(response.headers.get("X-Analysis-Prepared-At")).toBe("1000");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(((await response.json()) as { accounts: unknown[] }).accounts).toEqual([card("codex", "codex1", 1), card("claude", "claude1", 2)]);
});

test("without a ready roster the preparation receipt stays (the page keeps polling)", async () => {
  const fallback = createRosterFallback();
  expect((await fallback.respond(KEY, "db", preparingReceipt())).status).toBe(202);
  // Another database's roster is never shown, nor another window length's.
  await fallback.respond(KEY, "other", roster([card("codex", "codex1", 1)]));
  expect((await fallback.respond(KEY, "db", preparingReceipt())).status).toBe(202);
  expect((await fallback.respond("/api/roster?window=300", "other", preparingReceipt())).status).toBe(202);
});

test("one preparing account takes its last ready card; the other accounts stay current", async () => {
  const time = clock();
  const fallback = createRosterFallback(time.now);
  await fallback.respond(KEY, "db", roster([card("codex", "codex1", 1), card("claude", "claude1", 2)]));
  time.advance(60_000);
  const response = await fallback.respond(KEY, "db",
    roster([placeholder("codex", "codex1"), card("claude", "claude1", 3)], [{ vendor: "codex", id: "codex1" }]));
  expect(response.headers.get("X-Analysis")).toBe("stale");
  expect(response.headers.get("X-Analysis-Prepared-At")).toBe("1000");
  const body = await response.json() as Record<string, unknown>;
  expect(body.accounts).toEqual([card("codex", "codex1", 1), card("claude", "claude1", 3)]);
  expect(body.count).toBe(2);
  expect(body.preparing_accounts).toBeUndefined();
  // The other account prepares next: each takes its own newest ready card.
  time.advance(60_000);
  const next = await (await fallback.respond(KEY, "db",
    roster([card("codex", "codex1", 4), placeholder("claude", "claude1")], [{ vendor: "claude", id: "claude1" }]))).json() as { accounts: unknown[] };
  expect(next.accounts).toEqual([card("codex", "codex1", 4), card("claude", "claude1", 3)]);
  // A whole preparing roster then answers that mix.
  const whole = await fallback.respond(KEY, "db", preparingReceipt());
  expect(whole.headers.get("X-Analysis-Prepared-At")).toBe("61000");
  expect(((await whole.json()) as { accounts: unknown[] }).accounts).toEqual(next.accounts);
});

test("an account never seen ready stays a placeholder, still marked stale so the page asks again", async () => {
  const fallback = createRosterFallback();
  const response = await fallback.respond(KEY, "db",
    roster([placeholder("codex", "codex1"), card("claude", "claude1", 2)], [{ vendor: "codex", id: "codex1" }]));
  expect(response.headers.get("X-Analysis")).toBe("stale");
  expect(((await response.json()) as { accounts: unknown[] }).accounts).toEqual([placeholder("codex", "codex1"), card("claude", "claude1", 2)]);
});

test("a vendor preparing as a whole gets its last ready cards back", async () => {
  const fallback = createRosterFallback();
  await fallback.respond(KEY, "db", roster([card("codex", "codex1", 1), card("glm", "glm", 5)]));
  const body = await (await fallback.respond(KEY, "db", roster([card("codex", "codex1", 2)], [{ vendor: "glm", id: null }]))).json() as { accounts: unknown[] };
  expect(body.accounts).toEqual([card("codex", "codex1", 2), card("glm", "glm", 5)]);
});

test("errors pass through untouched", async () => {
  const fallback = createRosterFallback();
  await fallback.respond(KEY, "db", roster([card("codex", "codex1", 1)]));
  const failed = await fallback.respond(KEY, "db", Response.json({ error: "busy" }, { status: 503 }));
  expect(failed.status).toBe(503);
});

test("committed meters survive a pending card after a reset and after restart", async () => {
  const current = { ...placeholder("claude", "seat"), claude: null,
    claude_meters: { weekly: { percent: 1, reset_at: "new-reset" }, session: { percent: 7 } } };
  for (const warm of [false, true]) {
    const fallback = createRosterFallback();
    if (warm) await fallback.respond(KEY, "db", roster([{ ...card("claude", "seat", 97), claude: { current: { reset_at: "old-reset" } } }]));
    const response = await fallback.respond(KEY, "db", roster([current], [{ vendor: "claude", id: "seat" }]));
    expect((await response.json() as {accounts:unknown[]}).accounts).toEqual([current]);
  }
});
