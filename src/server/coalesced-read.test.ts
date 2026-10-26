import { describe, expect, test } from "bun:test";
import { CoalescedReads } from "./coalesced-read";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("coalesced reads", () => {
  test("identical revision/key shares work but returns independently consumable responses", async () => {
    const reads = new CoalescedReads();
    const wait = gate();
    let calls = 0;
    const build = async () => { calls++; await wait.promise; return Response.json({ value: 7 }, { headers: { "X-Source": "test" } }); };
    const one = reads.run("rev1:key", new AbortController().signal, build);
    const two = reads.run("rev1:key", new AbortController().signal, build);
    await Promise.resolve();
    expect(calls).toBe(1);
    wait.release();
    const [a, b] = await Promise.all([one, two]);
    expect(await a.json()).toEqual({ value: 7 });
    expect(await b.json()).toEqual({ value: 7 });
    expect(b.headers.get("X-Source")).toBe("test");
    expect(b.headers.get("X-Cache")).toBe("coalesced");
    expect(reads.active()).toBe(0);
  });

  test("cancelling the initiating caller does not cancel another subscriber", async () => {
    const reads = new CoalescedReads();
    const wait = gate();
    const first = new AbortController(), second = new AbortController();
    let workSignal: AbortSignal | undefined;
    const build = async (signal: AbortSignal) => { workSignal = signal; await wait.promise; return Response.json({ ok: true }); };
    const a = reads.run("key", first.signal, build);
    const b = reads.run("key", second.signal, build);
    await Promise.resolve();
    first.abort();
    expect((await a).status).toBe(499);
    expect(workSignal?.aborted).toBe(false);
    wait.release();
    expect((await b).status).toBe(200);
  });

  test("last cancellation abandons work and a late completion cannot remove its replacement", async () => {
    const reads = new CoalescedReads();
    const old = gate(), next = gate();
    const caller = new AbortController();
    let oldSignal: AbortSignal | undefined;
    const first = reads.run("key", caller.signal, async signal => {
      oldSignal = signal; await old.promise; throw new Error("abandoned");
    });
    await Promise.resolve();
    caller.abort();
    expect((await first).status).toBe(499);
    expect(oldSignal?.aborted).toBe(true);
    expect(reads.active()).toBe(0);
    const second = reads.run("key", new AbortController().signal, async () => { await next.promise; return Response.json(2); });
    old.release();
    await Bun.sleep(0);
    expect(reads.active()).toBe(1);
    next.release();
    expect(await (await second).json()).toBe(2);
    expect(reads.active()).toBe(0);
  });

  test("different revisions never share work", async () => {
    const reads = new CoalescedReads();
    let calls = 0;
    const build = async () => Response.json(++calls);
    const [a, b] = await Promise.all([
      reads.run("rev1:key", new AbortController().signal, build),
      reads.run("rev2:key", new AbortController().signal, build),
    ]);
    expect(calls).toBe(2);
    expect(await a.json()).not.toBe(await b.json());
  });

  test("failed work is retryable and non-200 responses keep their status and headers", async () => {
    const reads = new CoalescedReads();
    await expect(reads.run("key", new AbortController().signal, async () => { throw new Error("retry"); })).rejects.toThrow("retry");
    expect(reads.active()).toBe(0);
    const error = await reads.run("key", new AbortController().signal, async () => Response.json({ error: "not ready" }, { status: 503, headers: { "Retry-After": "5" } }));
    expect(error.status).toBe(503);
    expect(error.headers.get("Retry-After")).toBe("5");
    expect(await error.json()).toEqual({ error: "not ready" });
  });

  test("already-aborted calls start no work", async () => {
    const reads = new CoalescedReads();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const response = await reads.run("key", controller.signal, async () => { calls++; return Response.json(1); });
    expect(response.status).toBe(499);
    expect(calls).toBe(0);
  });

  test("pending bookkeeping is bounded without dropping distinct requests", async () => {
    const reads = new CoalescedReads(1);
    const wait = gate();
    const first = reads.run("one", new AbortController().signal, async () => { await wait.promise; return Response.json(1); });
    const second = await reads.run("two", new AbortController().signal, async () => Response.json(2));
    expect(await second.json()).toBe(2);
    expect(reads.active()).toBe(1);
    wait.release();
    expect(await (await first).json()).toBe(1);
    expect(reads.active()).toBe(0);
  });
});
