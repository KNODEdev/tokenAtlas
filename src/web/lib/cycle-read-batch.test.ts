import { expect, test, spyOn } from "bun:test";
import { createCycleReadBatch } from "./cycle-read-batch";
import { preparedResponse } from "./prepared-response";
import { api, apiReadsAffected, bustApiMemo, refreshApiData, trackApiReads } from "./api";
import { installTestDom } from "./test-dom-harness";

const url = (n: number) => `http://local/api/cycle-breakdown?account=a&since_ts=${n}&until_ts=${n + 1}&valuation=dated`;
const envelope = (body: unknown, status = 200, headers: Array<[string, string]> = []) => ({ body: JSON.stringify(body), status, headers });
const mockFetch = (fn: (url: string, init?: RequestInit) => Promise<Response>) => Object.assign(fn, { preconnect() {} }) as typeof fetch;

test("twelve cycle reads use one bounded transport; identical reads have one serialized envelope", async () => {
  const calls: string[][] = [];
  const batch = createCycleReadBatch(mockFetch(async input => {
    const paths = JSON.parse(new URL(input).searchParams.get("requests")!) as string[];
    calls.push(paths);
    return Response.json({ responses: paths.map(path => envelope({ path })) });
  }));
  const values = await Promise.all([...Array.from({ length: 12 }, (_, i) => i), 0].map(i => batch(url(i)).then(res => res.json())));
  expect(calls.map(group => group.length)).toEqual([12]);
  expect(values[0]).toEqual(values[12]);
  const duplicate = await Promise.all([batch(url(1)), batch(url(1))]);
  expect(calls.at(-1)).toHaveLength(1);
  expect(await duplicate[0]!.json()).toEqual(await duplicate[1]!.json());
  calls.length = 0;
  await Promise.all(Array.from({ length: 13 }, (_, i) => batch(url(i))));
  expect(calls.map(group => group.length)).toEqual([12, 1]);
});

test("pending subreads alone retry; ready bodies and stale headers survive unchanged", async () => {
  const calls: string[][] = [];
  const batch = createCycleReadBatch(mockFetch(async input => {
    const paths = JSON.parse(new URL(input).searchParams.get("requests")!) as string[]; calls.push(paths);
    return Response.json({ responses: paths.map((path, index) => calls.length === 1 && index === 1
      ? envelope({ status: "preparing" }, 202, [["X-Analysis", "preparing"], ["X-Analysis-Poll-Ms", "100"]])
      : envelope({ path }, 200, [["X-Analysis", "stale"], ["X-Analysis-Prepared-At", "123"]])) });
  }));
  const responses = await Promise.all([0, 1].map(i => preparedResponse(url(i), { fetcher: batch, wait: async () => {} })));
  expect(calls.map(group => group.length)).toEqual([2, 1]);
  expect(responses[0]!.headers.get("X-Analysis-Prepared-At")).toBe("123");
  expect((await responses[1]!.json()).path).toContain("since_ts=1");
});

test("an account switch abandons its batch; one cancelled consumer leaves other consumers running", async () => {
  let transport: AbortSignal | undefined, finish: ((value: Response) => void) | undefined;
  const batch = createCycleReadBatch(mockFetch(async (_input, init) => {
    transport = init?.signal ?? undefined;
    return new Promise(resolve => { finish = resolve; });
  }));
  const a = new AbortController(), b = new AbortController();
  const first = batch(url(0), { signal: a.signal }), second = batch(url(1), { signal: b.signal });
  await Bun.sleep(0); a.abort(); expect(transport?.aborted).toBe(false);
  finish!(Response.json({ responses: [envelope({ tokens: 1 }), envelope({ tokens: 2 })] }));
  await expect(first).rejects.toBeDefined(); expect(await (await second).json()).toEqual({ tokens: 2 });
  const abandoned = new AbortController(); const next = batch(url(2), { signal: abandoned.signal });
  await Bun.sleep(0); abandoned.abort(); expect(transport?.aborted).toBe(true);
  finish!(Response.json({ responses: [envelope({ tokens: 3 })] }));
  await expect(next).rejects.toBeDefined();
});

test("batch transport retains canonical completed memo and scoped refresh dependencies", async () => {
  const dom = installTestDom(); Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://local" } });
  bustApiMemo(); let calls = 0; const paths: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(mockFetch(async input => {
    calls++;
    const items = JSON.parse(new URL(input).searchParams.get("requests")!) as string[]; paths.push(...items);
    return Response.json({ responses: items.map(path => envelope({ path })) });
  }));
  const controller = new AbortController(), stop = trackApiReads(controller.signal);
  const args = { account: "batch-seat", since_ts: "2026-09-01T00:00:00Z", until_ts: "2026-09-02T00:00:00Z" };
  try {
    const [first, duplicate] = await Promise.all([api.cycleBreakdown(args, controller.signal, true), api.cycleBreakdown(args, undefined, true)]);
    expect(first).toEqual(duplicate); expect(calls).toBe(1); expect(paths).toHaveLength(1);
    expect(apiReadsAffected(controller.signal, { unchanged: paths })).toBe(false);
    refreshApiData({ unchanged: paths }); await api.cycleBreakdown(args, undefined, true); expect(calls).toBe(1);
    refreshApiData({ unchanged: [] }); await api.cycleBreakdown(args, undefined, true); expect(calls).toBe(2);
  } finally { stop(); fetch.mockRestore(); bustApiMemo(); dom.restore(); }
});
