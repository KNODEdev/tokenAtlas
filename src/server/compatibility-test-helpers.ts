import { expect } from "bun:test";

/** The era timeline note that described the retired detected boundaries (stage 4, W4). */
const RETIRED_BOUNDARY_NOTE = "Granice przerywane są wykryte, nie zadeklarowane — deklarację poprawia się ręcznie w accounts.json.";

/**
 * These additive diagnostics did not exist in the frozen routers, and the era-boundary suggestion
 * (stage 4, W4) and the Codex owner report of `/api/accounts` (W6) no longer exist in the current
 * ones. Stage 4 also retires the empty phantom Claude row and versions the current
 * configuration fingerprint. Usage and probe measurements are compared unchanged.
 */
export function legacyRouterContract<T>(value: T): T {
  if (Array.isArray(value)) return value.map(legacyRouterContract) as T;
  if (value && typeof value === "object") {
    const response = value as { url?: string; body?: { count?: number; subscriptions?: Array<Record<string, unknown>> } };
    if (response.url === "/api/accounts" && response.body?.subscriptions) {
      const retired = response.body.subscriptions.filter(row => row.id === "claude" && row.vendor === "claude");
      for (const row of retired) expect(row).toMatchObject({ event_rows: 0, has_events: false, homes: [] });
      const subscriptions = response.body.subscriptions.filter(row => !retired.includes(row));
      value = { ...response, body: { ...response.body, count: subscriptions.length, subscriptions } } as T;
    }
    const node = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(node).flatMap(([key, child]) => {
      if (key === "configuration" && "probes" in node && "published_probes" in node) {
        expect(child).toMatch(/^[a-f0-9]{64}$/);
        return [];
      }
      if (key === "key" && "measured_at" in node && "used_percent" in node && typeof child === "string") {
        const parts = JSON.parse(child);
        expect(parts).toHaveLength(6);
        return [[key, JSON.stringify(parts)]];
      }
      if (key === "discovery_diagnostics" || key === "account_sources") {
        expect(child).toEqual([]);
        return [];
      }
      // The retired owner report: counts about owner tables the current routers no longer write.
      if (key === "attribution" && (child === null || typeof child === "object" && "rollouts" in child)) return [];
      // The frozen fixture never detected a boundary, so the retired field was always null.
      if (key === "boundary") {
        expect(child).toBeNull();
        return [];
      }
      if (key === "notes" && Array.isArray(child)) return [[key, child.filter((note) => note !== RETIRED_BOUNDARY_NOTE)]];
      return [[key, legacyRouterContract(child)]];
    })) as T;
  }
  return value;
}

/**
 * The frozen reader predates the expanded era fingerprint and must fail closed. The current database
 * has no daily summary tables (0054), so its era timeline reads Codex usage from the events, as the
 * current reader's ledger counts it.
 */
export function expectFrozenReadOnlyRollback(actual: any[], ready: any[]): void {
  const expected=structuredClone(ready);
  for (const response of expected) {
    if (response.url!=="/api/bootstrap" && !response.url.startsWith("/api/subscriptions/")) continue;
    response.body.status="error";
    response.body.error_code="attribution-conflict";
    // The v2 physical-source configuration stamp is newer than the frozen reader's registry stamp.
    response.body.updating=true;
    const subscriptions=response.url==="/api/bootstrap" ? response.body.data.subscriptions : [response.body.data];
    for (const subscription of subscriptions) Object.assign(subscription,{
      declaration_conflict:true,limits:[],latest_error:null,clock_warning:false,limits_truncated:false,
    });
  }
  expect(actual).toEqual(expected);
}
