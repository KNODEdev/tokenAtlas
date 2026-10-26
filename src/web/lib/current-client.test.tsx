import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentLimitView, CurrentOverview } from "../components/CurrentOverview";
import type { BootstrapSnapshot, CurrentLimit } from "./current-contract";
import { PORTFOLIO_CONTEXT, readCurrent, validCurrentSelection } from "./current-client";

describe("current client", () => {
  it("starts at portfolio and does not hardcode a provider", () => {
    expect(validCurrentSelection(null, ["only"])).toBe(PORTFOLIO_CONTEXT);
    expect(validCurrentSelection("deleted", ["only"])).toBe(PORTFOLIO_CONTEXT);
    expect(validCurrentSelection("only", ["only"])).toBe("only");
  });
  it("conditional GET retains the validated resource on 304", async () => {
    const previous = { data: { value: 42 }, etag: '"v1"' };
    let headers: HeadersInit | undefined;
    const fetcher = (async (_url: string, options: RequestInit) => { headers = options.headers; return new Response(null, { status: 304 }); }) as unknown as typeof fetch;
    expect(await readCurrent("/api/bootstrap", new AbortController().signal, previous, fetcher)).toBe(previous);
    expect(headers).toEqual({ "If-None-Match": '"v1"' });
  });
  it("forwards cancellation and rejects an aborted request", async () => {
    const controller = new AbortController();
    const fetcher = ((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(options.signal).toBe(controller.signal);
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const result = readCurrent("/api/bootstrap", controller.signal, undefined, fetcher);
    controller.abort();
    await expect(result).rejects.toThrow("Aborted");
  });
  it("does not echo arbitrary server diagnostics on failure", async () => {
    const fetcher = (async () => new Response("secret path/token", { status: 503 })) as unknown as typeof fetch;
    await expect(readCurrent("/api/bootstrap", new AbortController().signal, undefined, fetcher)).rejects.toThrow("(503)");
  });
});
function limit(changes: Partial<CurrentLimit> = {}): CurrentLimit {
  return {
    key: "one", kind: "primary", group: "main", scope: "subscription", window_minutes: 300, plan: null,
    measured_at: new Date(Date.now() - 60_000).toISOString(), machine: null,
    used_percent: 42, remaining_percent: 58, used: null, remaining: null, allowance: null,
    resets_at: new Date(Date.now() + 3600_000).toISOString(), rate_limit_reached: null,
    basis: "measured", age_minutes: 1, freshness: "fresh", ...changes,
  };
}
describe("current-state presentation", () => {
  it("an offline reset cannot leave yesterday's percentage visible", () => {
    const html = renderToStaticMarkup(<CurrentLimitView limit={limit({ resets_at: "2020-01-01T00:00:00Z" })} offline />);
    expect(html).not.toContain("42%"); expect(html).toContain("after reset");
  });
  it("does not fabricate machine identity and marks offline measurements", () => {
    const html = renderToStaticMarkup(<CurrentLimitView limit={limit()} offline />);
    expect(html).toContain("unknown machine"); expect(html).toContain("offline");
  });
  it("keeps a declared subscription visible with no measurements", () => {
    const snapshot: BootstrapSnapshot = {
      schema_version: 1, generation: 0, source_revisions: { probes: 0, published_probes: 0, configuration: "a" },
      generated_at: null, coverage_through: null, status: "initializing", updating: true, error_code: null,
      data: { default_context: "all", configured: true, subscriptions: [{
        id: "only", vendor: "gemini", label: "Paid without source", account_identity: null, identity_basis: "unknown",
        lifecycle: "active", binding_active: false, declaration_conflict: false,
        limits: [], latest_error: null, clock_warning: false, limits_truncated: false,
      }] },
    };
    const html = renderToStaticMarkup(<CurrentOverview snapshot={snapshot} onSelect={() => {}} onHistory={() => {}} />);
    expect(html).toContain("Paid without source"); expect(html).toContain("This does not mean 0%");
    expect(html).toContain("are not summed or averaged");
  });
});
