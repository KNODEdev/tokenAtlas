import { expect, test, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS } from "../../server/claude-code-capacity.fixture";
import { createFetchHandler, type AppContext } from "../../server/api";
import { advanceCapacityCycleResults } from "../../server/capacity-cycle-producer";
import { dataVersion } from "../../server/data-version";
import { registerFreshness, registersOfSources } from "../../db/read-freshness";
import { DATA_VIEWS } from "../../server/data-views";
import { api, bustApiMemo, refreshApiData, syncRevisionDecision, type SyncStatus } from "./api";
import { useAsync } from "./useAsync";
import { installTestDom } from "./test-dom-harness";

test("Capacity publication alone wakes a mounted consumer through the real sync status handler", async () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const ctx = { sqlite: fixture.db, accounts: { version: 2,
    subscriptions: Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude" })), sources: [] },
    rateCards: fixture.rates, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
  const handle = createFetchHandler(ctx);
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://fixture.local" } });
  const calls: string[] = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); calls.push(new URL(request.url).pathname); return handle(request);
  }, { preconnect() {} }) as typeof fetch);
  const status = async () => (await handle(new Request("http://fixture.local/api/sync"))).json() as Promise<SyncStatus>;
  function Reader() {
    const state = useAsync(signal => api.capacityCycles({ since: "2026-09-13", until: "2026-09-19", window_minutes: 10080 }, signal), []);
    return <span>{state.data?.accounts.some(account => account.preparing) ? "pending" : state.data?.accounts.reduce((sum, account) => sum + account.windows.length, 0) ?? "loading"}</span>;
  }
  try {
    bustApiMemo();
    await act(async () => { root.render(<Reader />); });
    expect(dom.host.textContent).toBe("pending");
    const before = await status(), version = dataVersion(fixture.db), other = dataVersion(fixture.db, { capacityCycles: false });
    for (let i = 0; i < 200; i++) {
      const result = advanceCapacityCycleResults(ctx, { budgetMs: 1000 });
      if (!result?.pending) break;
      if (i === 199) throw new Error("Capacity projection did not settle");
    }
    const after = await status();
    expect(after.revisions?.data).toBe(before.revisions?.data);
    expect(after.revisions?.config).toBe(before.revisions?.config);
    expect(after.revisions?.derived).not.toBe(before.revisions?.derived);
    expect(dataVersion(fixture.db)).not.toBe(version);
    expect(dataVersion(fixture.db, { capacityCycles: false })).toBe(other);
    expect(registersOfSources(DATA_VIEWS["/api/capacity-cycles"]!.sources)).toEqual(["capacity_cycle_results"]);
    expect(registerFreshness(fixture.db, "capacity_cycle_results")).toMatchObject({ published: true, pending: false });
    const decision = syncRevisionDecision(syncRevisionDecision(undefined, before).revision, after);
    expect(decision.refresh).toBe(true);
    await act(async () => { if (decision.refresh) refreshApiData(); });
    expect(dom.host.textContent).not.toBe("pending");
    expect(Number(dom.host.textContent)).toBeGreaterThan(0);
    expect(calls.filter(path => path === "/api/capacity-cycles")).toHaveLength(2);
    const settled = await status();
    expect(advanceCapacityCycleResults(ctx)?.processed).toBe(0);
    expect((await status()).revisions).toEqual(settled.revisions);
  } finally {
    await act(async () => root.unmount()); mocked.mockRestore(); bustApiMemo(); dom.restore(); fixture.teardown();
  }
});
