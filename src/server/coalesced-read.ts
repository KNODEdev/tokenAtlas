interface ResponseSnapshot {
  body: string;
  status: number;
  statusText: string;
  headers: [string, string][];
}

interface PendingRead {
  controller: AbortController;
  promise: Promise<ResponseSnapshot>;
  waiters: number;
  settled: boolean;
}

export function cancelledRead(): Response {
  return new Response(null, { status: 499, statusText: "Client Closed Request" });
}

/** Shares computation, never a Response body or an individual caller's cancellation. */
export class CoalescedReads {
  private pending = new Map<string, PendingRead>();

  constructor(private readonly maxPending = 256) {}

  active(): number { return this.pending.size; }

  async run(key: string, signal: AbortSignal, build: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (signal.aborted) return cancelledRead();
    let entry = this.pending.get(key);
    const joined = entry !== undefined;
    if (!entry) {
      // Bound bookkeeping, not request admission; saturated callers retain normal cancellation.
      if (this.pending.size >= this.maxPending) return build(signal);
      const controller = new AbortController();
      const created: PendingRead = {
        controller, waiters: 0, settled: false,
        promise: Promise.resolve().then(async () => {
          const response = await build(controller.signal);
          return {
            body: await response.text(), status: response.status, statusText: response.statusText,
            headers: [...response.headers.entries()],
          };
        }).finally(() => {
          created.settled = true;
          if (this.pending.get(key) === created) this.pending.delete(key);
        }),
      };
      entry = created;
      this.pending.set(key, entry);
    }
    const current = entry;
    current.waiters++;
    return new Promise<Response>((resolve, reject) => {
      let done = false;
      const release = (): boolean => {
        if (done) return false;
        done = true;
        signal.removeEventListener("abort", abort);
        current.waiters--;
        if (current.waiters === 0 && !current.settled) {
          if (this.pending.get(key) === current) this.pending.delete(key);
          current.controller.abort();
        }
        return true;
      };
      const abort = (): void => { if (release()) resolve(cancelledRead()); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      current.promise.then((snapshot) => {
        if (!release()) return;
        const headers = new Headers(snapshot.headers);
        if (joined && snapshot.status === 200) headers.set("X-Cache", "coalesced");
        const body = [204, 205, 304].includes(snapshot.status) ? null : snapshot.body;
        resolve(new Response(body, { status: snapshot.status, statusText: snapshot.statusText, headers }));
      }, (error: unknown) => { if (release()) reject(error); });
    });
  }
}
