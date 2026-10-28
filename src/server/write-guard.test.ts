import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { createFetchHandler, type AppContext } from "./api";
import { refuseCrossSiteWrite, refuseForeignHost } from "./write-guard";

test("foreign authorities cannot reach reads, writes or static pages", async () => {
  const { db, fetch } = router();
  try {
    for (const host of ["attacker.example", "127.0.0.1.evil.example", "localhost.evil.example"])
      for (const route of ["/", "/api/accounts", "/api/setup"])
        expect((await fetch(new Request(`http://${host}:7331${route}`))).status).toBe(403);
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      expect(refuseForeignHost(new Request(`http://${host}:7331/api/accounts`))).toBeNull();
    expect(refuseForeignHost(new Request("http://localhost/api/accounts", { headers: { host: "evil.example" } }))?.status).toBe(403);
  } finally { db.close(); }
});

// Write routes a page on another site could reach with a simple request (no CORS preflight).
const WRITE_ROUTES = [
  "/api/manual-capacity", "/api/plans", "/api/plans-catalog", "/api/cycles", "/api/rate-cards", "/api/account-periods",
  "/api/subscription-timeline-markers?provider=claude", "/api/codex-timeline-markers", "/api/grok-anchor",
  "/api/codex-pricing", "/api/codex-ledger-settings", "/api/sync?mode=full", "/api/analysis/rebuild",
  "/api/projects/assign", "/api/projects/remap", "/api/setup", "/api/setup/confirm", "/api/setup/database",
  "/api/setup/temporary", "/api/setup/cloud-sessions", "/api/source-profile", "/api/index-snapshot", "/api/credit-notices", "/api/claude-login",
];

/** A router whose every request past the guard answers 503 (database relocation), so no write handler runs. */
function router() {
  const db = new Database(":memory:");
  return { db, fetch: createFetchHandler({ sqlite: db, databaseRelocating: true } as AppContext) };
}
const request = (route: string, init: RequestInit) => new Request("http://127.0.0.1:7331" + route, { method: "POST", ...init });

test("a forged text/plain POST is refused on every write route before its handler", async () => {
  const { db, fetch } = router();
  try {
    for (const route of WRITE_ROUTES) {
      const forged = await fetch(request(route, { headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
        body: JSON.stringify({ plans: [] }) }));
      expect({ route, status: forged.status }).toEqual({ route, status: 403 });
      expect(await forged.json()).toEqual({ error: "Cross-origin request refused" });
      // Without an Origin (an old browser or a script) the body type alone still refuses it.
      expect((await fetch(request(route, { headers: { "content-type": "text/plain" }, body: "{}" }))).status).toBe(403);
    }
  } finally { db.close(); }
});

test("a JSON write from a foreign or opaque Origin is refused; the app page's own JSON write passes", async () => {
  const { db, fetch } = router();
  try {
    for (const route of WRITE_ROUTES) {
      for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example:7331", "null"])
        expect({ route, origin, status: (await fetch(request(route, { headers: { "content-type": "application/json", origin }, body: "{}" }))).status })
          .toEqual({ route, origin, status: 403 });
    }
    // Same page, the Vite proxy on another loopback port, and a script without Origin all reach the route.
    for (const headers of <Record<string, string>[]>[{ "content-type": "application/json", origin: "http://127.0.0.1:7331" },
      { "content-type": "application/json; charset=utf-8", origin: "http://localhost:5173" }, { "content-type": "application/json" }])
      expect((await fetch(request("/api/plans", { headers, body: "{}" }))).status).toBe(503);
  } finally { db.close(); }
});

test("every write method is guarded and reads are untouched", async () => {
  const { db, fetch } = router();
  try {
    for (const method of ["PUT", "DELETE", "PATCH"])
      expect((await fetch(request("/api/account-periods", { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" }))).status).toBe(403);
    expect((await fetch(request("/api/cycles", { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" }))).status).toBe(403);
    expect((await fetch(request("/api/sync", { method: "POST" }))).status).toBe(403);
    expect(refuseCrossSiteWrite(new Request("http://127.0.0.1:7331/api/plans", { headers: { origin: "https://evil.example" } }))).toBeNull();
    expect(refuseCrossSiteWrite(new Request("http://127.0.0.1:7331/api/plans", { method: "HEAD" }))).toBeNull();
    expect(refuseCrossSiteWrite(new Request("http://127.0.0.1:7331/api/plans", { method: "OPTIONS", headers: { origin: "https://evil.example" } }))).toBeNull();
  } finally { db.close(); }
});
