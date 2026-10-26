import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  BootstrapData, CurrentEnvelope, CurrentIdentity, CurrentLimit, CurrentSubscription, SubscriptionDeclaration,
} from "../../web/lib/current-contract";
import type { SourceDeclaration } from "../archive-source";
import { loadAccountResolver } from "../account-resolver";
import { archiveSourceKey } from "../event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../../config/paths";
import { currentConfigFingerprint, currentRegistry, registryFingerprint } from "./registry";
import { projectionState, readCurrentSubject, type StoredLimit } from "./store";

export interface CurrentContext {
  sqlite: Database;
  accounts: { subscriptions: SubscriptionDeclaration[]; sources: SourceDeclaration[] };
  attributionBlocked?: boolean;
}
/** Freshness belongs to the measurement, not the time its snapshot was published. */
export function presentLimit(limit: StoredLimit, vendor: string, now: number): CurrentLimit {
  const { conflicting, ...data } = limit;
  const age = (now - Date.parse(limit.measured_at)) / 60_000;
  const expired = limit.resets_at != null && Date.parse(limit.resets_at) <= now;
  const freshness = conflicting ? "conflict" : age < -5 ? "clock-skew" : expired ? "expired"
    : age > (vendor === "gemini" ? 90 : 15) ? "stale" : "fresh";
  const invalid = freshness === "expired" || freshness === "conflict" || freshness === "clock-skew";
  return {
    ...data, age_minutes: Math.max(0, Math.floor(age)), freshness,
    // An expired reading is not today's reading (and especially not zero).
    ...(invalid ? { used_percent: null, remaining_percent: null, used: null, remaining: null, rate_limit_reached: null } : {}),
  };
}
function subscription(ctx: CurrentContext, identity: CurrentIdentity, now: number, maxLimits: number): CurrentSubscription {
  const blocked = ctx.attributionBlocked || identity.declaration_conflict;
  const saved = blocked ? null : readCurrentSubject(ctx.sqlite, identity.vendor, identity.id);
  return {
    ...identity, declaration_conflict: Boolean(blocked),
    limits: saved?.limits.slice(0, maxLimits).map((limit) => presentLimit(limit, identity.vendor, now)) ?? [],
    latest_error: saved?.latest_error ?? null, clock_warning: saved?.clock_warning ?? false,
    limits_truncated: Boolean(saved?.limits_truncated || (saved?.limits.length ?? 0) > maxLimits),
  };
}
function activeBindings(ctx: CurrentContext, registry: CurrentIdentity[], now: number): CurrentIdentity[] {
  const sources = new Set(ctx.accounts.sources.map(row => archiveSourceKey(row.home, ARCHIVE_LOGICAL_ROOT))
    .filter((source): source is string => source != null));
  if (!sources.size) return registry;
  const resolver = loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions);
  return registry.map(identity => ({ ...identity,
    binding_active: resolver.plan(identity.vendor, identity.id).ranges.some(range =>
      sources.has(range.source) && range.from <= now && now < range.until),
  }));
}
export function currentSnapshot(ctx: CurrentContext, now = new Date().toISOString(), id?: string): CurrentEnvelope<BootstrapData | CurrentSubscription> | null {
  // A read transaction pins the published rows and the revision metadata together.
  // No DDL, probe queries, live polling or rebuilding is permitted in this path.
  return ctx.sqlite.transaction((): CurrentEnvelope<BootstrapData | CurrentSubscription> | null => {
    const registry = currentRegistry(ctx.accounts.subscriptions, now);
    const presented = activeBindings(ctx, registry, Date.parse(now));
    const selected = id == null ? undefined : presented.find((row) => row.id === id);
    if (id != null && !selected) return null;
    const state = projectionState(ctx.sqlite);
    const fingerprint = state?.schema_version === 2
      ? currentConfigFingerprint(registry, ctx.accounts.sources) : registryFingerprint(registry);
    const updating = state == null || state.generated_at == null || state.config_fingerprint !== fingerprint
      || state.probe_revision !== state.published_probe_revision;
    const empty = (identity: CurrentIdentity): CurrentSubscription => ({
      ...identity, declaration_conflict: Boolean(identity.declaration_conflict || ctx.attributionBlocked),
      limits: [], latest_error: null, clock_warning: false, limits_truncated: false,
    });
    // Configuration changes are cheap to expose, but readings wait for their registry generation.
    const row = (identity: CurrentIdentity, limit: number) => !state?.generated_at || state.config_fingerprint !== fingerprint
      ? empty(identity) : subscription(ctx, identity, Date.parse(now), limit);
    const error = !state ? "migration-required" : ctx.attributionBlocked ? "attribution-conflict" : state.error_code;
    return {
      schema_version: 1, generation: state?.generation ?? 0,
      source_revisions: { probes: state?.probe_revision ?? 0, published_probes: state?.published_probe_revision ?? 0, configuration: fingerprint },
      generated_at: state?.generated_at ?? null, coverage_through: null,
      status: error ? "error" : !state?.generated_at ? "initializing" : updating ? "updating" : "ready",
      updating, error_code: error,
      data: selected ? row(selected, 32) : {
        subscriptions: presented.map((identity) => row(identity, 2)), default_context: "all", configured: registry.length > 0,
      },
    };
  }).deferred();
}
export function handleCurrentRequest(ctx: CurrentContext, req: Request, now = new Date().toISOString()): Response | null {
  const pathname = new URL(req.url).pathname;
  const match = /^\/api\/subscriptions\/([^/]+)\/current$/.exec(pathname);
  if (pathname !== "/api/bootstrap" && pathname !== "/api/revisions" && !match) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
  let id: string | undefined;
  try { id = match ? decodeURIComponent(match[1]!).trim().toLowerCase() : undefined; }
  catch { return Response.json({ error: "Invalid subscription identifier" }, { status: 400 }); }
  let body: unknown;
  if (pathname === "/api/revisions") {
    const state = projectionState(ctx.sqlite);
    body = {
      schema_version: 1, generation: state?.generation ?? 0,
      probes: state?.probe_revision ?? 0, published_probes: state?.published_probe_revision ?? 0,
      configuration: state?.schema_version === 2
        ? currentConfigFingerprint(currentRegistry(ctx.accounts.subscriptions, now), ctx.accounts.sources)
        : registryFingerprint(currentRegistry(ctx.accounts.subscriptions, now)),
      generated_at: state?.generated_at ?? null, error_code: state?.error_code ?? null,
    };
  } else {
    body = currentSnapshot(ctx, now, id);
    if (!body) return Response.json({ error: "Unknown subscription" }, { status: 404 });
  }
  const text = JSON.stringify(body);
  const etag = '"' + createHash("sha256").update(text).digest("hex") + '"';
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-cache", ETag: etag };
  const cached = req.headers.get("If-None-Match")?.split(",").map((value) => value.trim().replace(/^W\//, "")) ?? [];
  if (cached.includes(etag) || cached.includes("*")) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : text, { headers });
}
