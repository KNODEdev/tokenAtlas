import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { database, settle as prepareSums, card, sources, opened, addEvent, publishLedger } from "./window-usage-codex.fixture";
import { ensureCapacityCycleResults, markCapacityCycleResultsDirty } from "../db/capacity-cycle-results";
import { advanceCapacityCycleResults } from "./capacity-cycle-producer";
import { capacityCyclesReference } from "../../scripts/lib/capacity-cycles-reference";
import { handleCodexCapacity, handleCodexCapacityRange } from "./codex-capacity";
import { DATA_VIEWS, serveDataView } from "./data-views";
import { directReadHandler } from "./direct-read";
import type { AppContext } from "./api";
import { markWindowUsageDirty } from "../db/window-usage";
import { COUNTER } from "./window-usage-codex.fixture";

const request = (since = "2026-09-01", until = "2026-09-21", minutes = 10080) =>
  new URL(`http://local/api/codex-capacity?since=${since}&until=${until}&account=codex1&window_minutes=${minutes}`);
function context(sqlite: Database): AppContext {
  return { sqlite, accounts: { version: 2, subscriptions: [{ id: "codex1", vendor: "codex" }], sources },
    rateCards: card, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
}
function settle(ctx: AppContext) {
  for (let i = 0; i < 100; i++) if (!advanceCapacityCycleResults(ctx, { budgetMs: 10000 })?.pending) return;
  throw new Error("Capacity results did not settle");
}
function close(db: Database) { opened.splice(opened.indexOf(db), 1); db.close(); }

test("ordinary Capacity reads only published cycles for new ranges/counters, without a response answer or writes", async () => {
  const db = database(), ctx = context(db);
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx);
    for (const minutes of [300, 43200]) db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','codex1',?,1,'ready')")
      .run(JSON.stringify(["codex", "codex", minutes]));
    expect(DATA_VIEWS["/api/codex-capacity"]?.direct).toBe(true);
    expect(DATA_VIEWS["/api/codex-capacity"]?.sources).toContain("capacity_cycle_results");
    expect(directReadHandler("/api/codex-capacity")).toBeFunction();
    const bounds = await handleCodexCapacityRange(ctx, new URL("http://local/api/codex-capacity-range?account=codex1" )).json();
    expect(bounds).toEqual({ range: { since: "2026-09-01", until: "2026-09-16" } });
    for (const url of [request(), request("2026-09-12", "2026-09-12"), request(undefined, undefined, 300), request(undefined, undefined, 43200)]) {
      const referenceUrl = new URL(url); referenceUrl.pathname = "/api/capacity-cycles";
      const expected = (await (await capacityCyclesReference(ctx, referenceUrl)).json()).accounts[0].windows;
      const before = db.query("SELECT total_changes() n").get();
      const query = spyOn(db, "query");
      let response: Response;
      try {
        response = await serveDataView(ctx, url);
        const sql = query.mock.calls.map(([text]) => text).join("\n");
        expect(sql).not.toMatch(/\b(?:events|probe_windows|usage_price_events|ratelimit|window_answers)\b/i);
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
      } finally { query.mockRestore(); }
      expect(response!.status).toBe(200);
      expect(response!.headers.get("X-Data-Version")).toBeTruthy();
      expect(response!.headers.get("X-Analysis")).toBe("stored");
      const body = await response!.json();
      expect(body).toMatchObject({ projection: true, scope: { account: "codex1" } });
      expect(body.windows).toEqual(expected);
      expect(body).not.toHaveProperty("events");
      expect(body).not.toHaveProperty("normalization");
      expect(db.query("SELECT total_changes() n").get()).toEqual(before);
    }
  } finally { close(db); }
});

test("pending correction retains the last result, publication corrects only its cycle, and a readonly restart reads it", async () => {
  const db = database(), ctx = context(db), directory = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-read-"));
  try {
    prepareSums(db); ensureCapacityCycleResults(db); settle(ctx);
    const before = await (await handleCodexCapacity(ctx, request())).json();
    markCapacityCycleResultsDirty(db, "codex", "codex1", Date.parse("2026-09-09"), Date.parse("2026-09-10"));
    const stale = await handleCodexCapacity(ctx, request());
    expect(stale.status).toBe(200); expect(stale.headers.get("X-Analysis")).toBe("stale");
    expect((await stale.json()).windows).toEqual(before.windows);
    addEvent(db, { ts: "2026-09-09T12:00:00.000Z", input: 200000 }); publishLedger(db, card);
    markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER, fromMs: Date.parse("2026-09-09"), untilMs: Date.parse("2026-09-10") });
    prepareSums(db); settle(ctx);
    const corrected = await (await handleCodexCapacity(ctx, request())).json();
    expect(corrected.windows).not.toEqual(before.windows);
    expect(corrected.windows[0]).toEqual(before.windows[0]);
    expect(corrected.windows[2]).toEqual(before.windows[2]);
    const reference = await (await capacityCyclesReference(ctx, new URL(request().href.replace("codex-capacity", "capacity-cycles")))).json();
    expect(corrected.windows).toEqual(reference.accounts[0].windows);
    const file = path.join(directory, "restart.sqlite");
    fs.writeFileSync(file, db.serialize());
    const restarted = new Database(file, { readonly: true });
    try {
      const response = await serveDataView(context(restarted), request());
      expect(response.status).toBe(200); expect(response.headers.get("X-Analysis")).toBe("stored");
      expect((await response.json()).windows).toEqual(corrected.windows);
      expect(restarted.query("SELECT COUNT(*) n FROM capacity_cycle_result_dirty").get()).toEqual({ n: 0 });
    } finally { restarted.close(); }
  } finally { close(db); fs.rmSync(directory, { recursive: true }); }
});

test("invalid scopes fail before database access; unfinished rows and preparation failures remain explicit", async () => {
  for (const suffix of ["account=all", "account=x::business", "project=x", "reference_day=2026-09-01", "window_minutes=42", "since=2026-02-30"]) {
    const url = request(); const [key, value] = suffix.split("="); url.searchParams.set(key!, value!);
    expect((await handleCodexCapacity({} as AppContext, url)).status).toBe(400);
  }
  const db = database(), ctx = context(db);
  try {
    ensureCapacityCycleResults(db);
    expect((await handleCodexCapacity(ctx, request())).status).toBe(202);
    prepareSums(db); settle(ctx);
    db.query("UPDATE capacity_cycle_results SET error='fixture failure' WHERE window_minutes=10080").run();
    const error = await handleCodexCapacity(ctx, request());
    expect(error.status).toBe(503); expect((await error.json()).error).toBe("fixture failure");
    markCapacityCycleResultsDirty(db, "codex", "codex1", Date.parse("2026-09-09"), null);
    expect((await handleCodexCapacity(ctx, request())).status).toBe(503);
  } finally { close(db); }
});
