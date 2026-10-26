import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  api,
  bustApiMemo,
  onApiRefresh,
  refreshApiData,
  refreshLiveApiData,
  readingsRevisionDecision,
  syncRevisionDecision,
  syncRequestPath,
  syncRunChanged,
  type SyncRunResult,
  type SyncStatus,
} from "./api";
import { staleSignalTime } from "./report-freshness";

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    running: false,
    trigger: "auto",
    mode: "incremental",
    started_at: "2026-08-31T10:00:00.000Z",
    finished_at: "2026-08-31T10:00:01.000Z",
    exit_code: 0,
    ok: true,
    phase: "done",
    phase_index: 8,
    phase_count: 8,
    log_tail: [],
    revisions: { data: 4, config: 2, derived: 4 },
    ...over,
  };
}

afterEach(() => bustApiMemo());

describe("sync revision refresh", () => {
  it("cancellable cycle breakdowns retain completed memo reuse and refresh after invalidation", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.local" } } });
    let calls = 0;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++; return Response.json({ totals: { tokens: calls } });
    }, { preconnect() {} }) as typeof fetch);
    const params = { account: "seat", since_ts: "2026-09-01T00:00:00Z", until_ts: "2026-09-02T00:00:00Z", end_inclusive: true };
    try {
      const first = await api.cycleBreakdown(params, new AbortController().signal);
      const again = await api.cycleBreakdown(params, new AbortController().signal);
      expect(again).toEqual(first);
      expect(calls).toBe(1);
      refreshApiData();
      const fresh = await api.cycleBreakdown(params, new AbortController().signal);
      expect(fresh.totals.tokens).toBe(2);
      expect(calls).toBe(2);
    } finally {
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("shares scoped GETs without letting one caller cancel another, including stale provenance", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.local" } } });
    let calls = 0, sharedSignal: AbortSignal | undefined, finish!: (response: Response) => void;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign((_url: unknown, init?: RequestInit) => {
      calls++; sharedSignal = init?.signal as AbortSignal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }, { preconnect() {} }) as typeof fetch);
    try {
      const a = new AbortController(), b = new AbortController();
      const one = api.windows({ account: "seat" }, a.signal), two = api.windows({ account: "seat" }, b.signal);
      expect(calls).toBe(1);
      a.abort();
      await expect(one).rejects.toThrow();
      expect(sharedSignal?.aborted).toBe(false);
      finish(Response.json({ windows: [] }, { headers: { "X-Analysis": "stale", "X-Analysis-Prepared-At": "1000" } }));
      expect((await two).windows).toEqual([]);
      expect(staleSignalTime(b.signal)).toBe(1000);
      const c = new AbortController(), d = new AbortController();
      const three = api.windows({ account: "another" }, c.signal), four = api.windows({ account: "another" }, d.signal);
      expect(calls).toBe(2);
      finish(Response.json({ windows: [] }, { headers: { "X-Analysis": "stale" } }));
      await Promise.all([three, four]);
      expect(staleSignalTime(c.signal)).toBeNull();
      expect(staleSignalTime(d.signal)).toBeNull();
      const fresh = api.windows({ account: "another" }, new AbortController().signal);
      expect(calls).toBe(3);
      finish(Response.json({ windows: [] }));
      await fresh;
    } finally {
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("abandons a shared fetch only after its last scoped caller leaves and allows a replacement", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.local" } } });
    const signals: AbortSignal[] = [];
    let finish!: (response: Response) => void;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign((_url: unknown, init?: RequestInit) => {
      const signal = init!.signal!; signals.push(signal);
      return new Promise<Response>((resolve, reject) => {
        finish = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, { preconnect() {} }) as typeof fetch);
    try {
      const a = new AbortController(), b = new AbortController();
      const one = api.windows({ account: "seat" }, a.signal), two = api.windows({ account: "seat" }, b.signal);
      a.abort();
      await expect(one).rejects.toThrow();
      expect(signals[0]!.aborted).toBe(false);
      b.abort();
      await expect(two).rejects.toThrow();
      expect(signals[0]!.aborted).toBe(true);
      const replacement = api.windows({ account: "seat" }, new AbortController().signal);
      expect(signals.length).toBe(2);
      finish(Response.json({ windows: [] }));
      await replacement;
      const unscoped = api.windows({ account: "mixed" }), c = new AbortController();
      const scoped = api.windows({ account: "mixed" }, c.signal);
      c.abort();
      await expect(scoped).rejects.toThrow();
      expect(signals.at(-1)!.aborted).toBe(false);
      finish(Response.json({ windows: [] }));
      expect((await unscoped).windows).toEqual([]);
    } finally {
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("a live reading preserves configuration and project totals while full refresh invalidates them", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.local" } } });
    let calls = 0;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      calls++; return Response.json({});
    }, { preconnect() {} }) as typeof fetch);
    try {
      await Promise.all([api.projects(), api.rateCards(), api.plansCatalog(), api.setupStatus(), api.windows({ account: "seat" }, new AbortController().signal)]);
      expect(calls).toBe(5);
      refreshLiveApiData();
      await Promise.all([api.projects(), api.rateCards(), api.plansCatalog(), api.setupStatus(), api.windows({ account: "seat" }, new AbortController().signal)]);
      expect(calls).toBe(6);
      refreshApiData();
      await Promise.all([api.projects(), api.rateCards(), api.plansCatalog(), api.setupStatus(), api.windows({ account: "seat" }, new AbortController().signal)]);
      expect(calls).toBe(11);
    } finally {
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("shares slow reads beyond the TTL and does not let an obsolete failure evict a newer read", async () => {
    const originalWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
    Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{origin:"http://fixture.local"}}});
    let now=1, calls=0;
    const clock=spyOn(Date,"now").mockImplementation(()=>now);
    let resolve!: (response:Response)=>void, reject!: (error:Error)=>void;
    const fetchMock=spyOn(globalThis,"fetch").mockImplementation(Object.assign(()=>{
      calls++;return new Promise<Response>((done,fail)=>{resolve=done;reject=fail;});
    },{preconnect:()=>{}}) as typeof fetch);
    try {
      const first=api.accounts();now+=60_000;
      const joined=api.accounts();expect(calls).toBe(1);
      resolve(Response.json({subscriptions:[]}));await Promise.all([first,joined]);
      await api.accounts();expect(calls).toBe(1);
      bustApiMemo();const obsolete=api.accounts().catch(()=>null);const failOld=reject;
      bustApiMemo();const current=api.accounts();failOld(new Error("old request failed"));await obsolete;
      const currentJoined=api.accounts();expect(calls).toBe(3);
      resolve(Response.json({subscriptions:[]}));await Promise.all([current,currentJoined]);
    } finally {clock.mockRestore();fetchMock.mockRestore();if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else delete (globalThis as {window?:unknown}).window;}
  });
  it("refreshes new readings during sync and when idle without refreshing history", () => {
    expect(readingsRevisionDecision(undefined, status({ readings_revision: 1 }))).toEqual({ revision: 1, refresh: false });
    expect(readingsRevisionDecision(1, status({ running: true, readings_revision: 2 }))).toEqual({ revision: 2, refresh: true });
    expect(readingsRevisionDecision(1, status({ readings_revision: 2 }))).toEqual({ revision: 2, refresh: true });
    expect(readingsRevisionDecision(1, status())).toEqual({ revision: 1, refresh: false });
    let live = 0, history = 0;
    const unsubLive = onApiRefresh(() => live++, true);
    const unsubHistory = onApiRefresh(() => history++);
    try {
      refreshLiveApiData();
      expect([live, history]).toEqual([1, 0]);
      refreshApiData();
      expect([live, history]).toEqual([2, 1]);
    } finally { unsubLive(); unsubHistory(); }
  });

  it("establishes an initial baseline and suppresses a no-op completion", () => {
    const initial = syncRevisionDecision(undefined, status());
    expect(initial).toEqual({ revision: "4:2:4", refresh: false });
    const noOp = syncRevisionDecision(
      initial.revision,
      status({ completion_id: "new-run", revisions: { data: 4, config: 2, derived: 4 } })
    );
    expect(noOp).toEqual({ revision: "4:2:4", refresh: false });
  });

  it("defers while work is running and refreshes after a committed revision changes", () => {
    expect(
      syncRevisionDecision("4:2:4", status({ running: true, revisions: { data: 5, config: 2, derived: 4 } }))
    ).toEqual({ revision: "4:2:4", refresh: false });
    expect(
      syncRevisionDecision("4:2:4", status({ revisions: { data: 5, config: 2, derived: 5 } }))
    ).toEqual({ revision: "5:2:5", refresh: true });
  });

  it("distinguishes a changed run from a completed no-op by committed revisions", () => {
    const run = {
      runId: "fixture",
      trigger: "manual" as const,
      scope: { kind: "all" as const },
      mode: "incremental" as const,
      startedAt: "2026-08-31T10:00:00.000Z",
      finishedAt: "2026-08-31T10:00:01.000Z",
      status: "success" as const,
      beforeRevisions: { data: 4, config: 2, vendors: { codex: 1, claude: 1, opencode: 1, grok: 1, gemini: 1, gauges: 0 } },
      afterRevisions: { data: 4, config: 2, vendors: { codex: 1, claude: 1, opencode: 1, grok: 1, gemini: 1, gauges: 0 } },
      aggregateWorkRequested: false,
      vendors: [],
      error: null,
    } satisfies SyncRunResult;
    expect(syncRunChanged(status({ run }))).toBe(false);
    expect(
      syncRunChanged(
        status({ run: { ...run, afterRevisions: { ...run.afterRevisions, data: 5 } } })
      )
    ).toBe(true);
  });

  it("sends a scoped full request with both mode and canonical vendor", async () => {
    expect(syncRequestPath("full", "grok")).toBe("/api/sync?mode=full&vendor=grok");
    expect(syncRequestPath("incremental", "claude")).toBe("/api/sync?vendor=claude");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "http://fixture.local" } },
    });
    let requestUrl = "";
    let requestMethod = "";
    const fakeFetch = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        requestUrl = String(input);
        requestMethod = init?.method ?? "GET";
        return Response.json(status());
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    try {
      await api.syncStart("full", "grok");
      expect(requestUrl).toBe("http://fixture.local/api/sync?mode=full&vendor=grok");
      expect(requestMethod).toBe("POST");
    } finally {
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("busts the GET memo before notifying every mounted dependent", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "http://fixture.local" } },
    });
    const requests: string[] = [];
    const fakeFetch = Object.assign(
      async (input: URL | RequestInfo) => {
        requests.push(String(input));
        return Response.json({ accounts: [] });
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    let dependentReloads = 0;
    const unsubscribe = onApiRefresh(() => {
      dependentReloads += 1;
    });
    try {
      await api.accounts();
      await api.accounts();
      expect(requests).toHaveLength(1);
      refreshApiData();
      expect(dependentReloads).toBe(1);
      await api.accounts();
      expect(requests).toHaveLength(2);
    } finally {
      unsubscribe();
      fetchMock.mockRestore();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
