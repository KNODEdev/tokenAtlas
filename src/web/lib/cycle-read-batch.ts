import { CYCLE_READ_BATCH_MAX, type CycleReadBatch } from "../../shared/cycle-read-batch";

interface Read { url: string; signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: unknown) => void }
/** Only Overview's cycle reads opt in; memoization and refresh tracking keep the single URL. */
export function createCycleReadBatch(fetcher?: typeof fetch): typeof fetch {
  let queued: Read[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const pending = queued; queued = [];
    const active = pending.filter(read => {
      if (!read.signal?.aborted) return true;
      read.reject(read.signal.reason); return false;
    });
    const groups = new Map<string, Read[]>();
    for (const read of active) { const group = groups.get(read.url) ?? []; group.push(read); groups.set(read.url, group); }
    const unique = [...groups.values()];
    for (let i = 0; i < unique.length; i += CYCLE_READ_BATCH_MAX) void send(unique.slice(i, i + CYCLE_READ_BATCH_MAX).flat());
  };
  const send = async (reads: Read[]) => {
    const controller = new AbortController();
    // One abandoned hook must not cancel the other consumers of the batch.
    const abort = () => { if (reads.every(read => read.signal?.aborted)) controller.abort(); };
    reads.forEach(read => read.signal?.addEventListener("abort", abort, { once: true }));
    try {
      abort(); controller.signal.throwIfAborted();
      const unique = [...new Set(reads.map(read => read.url))];
      const url = new URL("/api/cycle-breakdowns", reads[0]!.url);
      url.searchParams.set("requests", JSON.stringify(unique.map(value => { const item = new URL(value); return item.pathname + item.search; })));
      const response = await (fetcher ?? fetch)(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`Cycle batch failed (${response.status})`);
      const body = await response.json() as CycleReadBatch;
      if (!Array.isArray(body.responses) || body.responses.length !== unique.length) throw new Error("Invalid cycle batch response");
      for (const read of reads) {
        if (read.signal?.aborted) { read.reject(read.signal.reason); continue; }
        const envelope = body.responses[unique.indexOf(read.url)]!;
        read.resolve(new Response(envelope.body || null, { status: envelope.status, headers: envelope.headers }));
      }
    } catch (error) { reads.forEach(read => read.reject(error)); }
    finally { reads.forEach(read => read.signal?.removeEventListener("abort", abort)); }
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    queued.push({ url: String(input), signal: init?.signal ?? undefined, resolve, reject });
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  })) as typeof fetch;
}
export const cycleReadBatch = createCycleReadBatch();
