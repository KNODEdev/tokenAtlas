import type { AccountResolver } from "./account-resolver";
import { loadAccountResolver } from "./account-resolver";
import type { AppContext, SubscriptionAccount } from "./app-context-types";
import { archiveFolderOf } from "./event-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { normEraVendor } from "./eras";
import { codexEventOwnedBy } from "./codex-event-owner";
import { codexAccountSelector, codexTableHomes } from "./codex-source-account";
import { claudeAccountId } from "./claude-limit";

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The account periods of this context: the resolver it carries, else one loaded for its database. */
export function accountResolverOf(ctx: Pick<AppContext, "sqlite" | "accounts" | "resolver">): AccountResolver {
  return ctx.resolver ?? loadAccountResolver(ctx.sqlite, ctx.accounts?.subscriptions);
}

/**
 * Which subscription owned a source at an instant. `source` is a CODEX_HOME, a
 * claude home, a grok store or a subscription id, depending on the vendor. Null
 * means no era claims it — the row stays unattributed rather than falling
 * through to whichever era happens to be the latest.
 */
export function resolveSubscription(
  ctx: AppContext,
  vendor: string,
  source: string,
  ts: string
): string | null {
  const direct = archiveFolderOf(source, ARCHIVE_LOGICAL_ROOT)?.key;
  const configured = new Set(ctx.accounts.sources
    .filter(row => normEraVendor(row.vendor) === normEraVendor(vendor) && row.source_home && normPath(row.source_home) === normPath(source))
    .flatMap(row => archiveFolderOf(row.home, ARCHIVE_LOGICAL_ROOT)?.key ?? []));
  const logical = direct ?? (configured.size === 1 ? [...configured][0]! : null)
    ?? (normEraVendor(vendor) === "glm" && /^[^/\\:]+$/.test(source) ? `glm/${normPath(source)}` : null)
    ?? (/^(?:codex|claude|grok|gemini|glm)\/[^/]+$/i.test(source) ? normPath(source) : null);
  return logical ? accountResolverOf(ctx).resolve(vendor, logical, null, ts).account : null;
}

export interface AccountScope {
  id: string;
  vendor: string;
  homes: string[];
}

export function resolveAccountScope(ctx: AppContext, id: string): AccountScope | null {
  const wanted = id.toLowerCase();
  const sub = distinctSubscriptions(ctx).find((s) => s.id.toLowerCase() === wanted);
  if (sub) {
    return {
      id: sub.id,
      vendor: sub.vendor || "codex",
      homes: (ctx.subIdToHomes.get(wanted) || []).map(normPath),
    };
  }
  if (wanted.endsWith("::business") && (ctx.sqlite.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(c => c.name === "billing_mode")) {
    // Business rows only (partial index); the pool's account is the period of each row's source.
    const pool = codexEventOwnedBy(ctx.sqlite, codexAccountSelector(ctx, "events"), wanted, { alias: "e" });
    const found = ctx.sqlite.query(`SELECT 1 FROM events e WHERE e.billing_mode='business_credits' AND ${pool.sql} LIMIT 1`).get(...pool.params);
    if (found) return { id: wanted, vendor: "codex", homes: [] };
  }
  if (wanted === "glm") {
    try {
      const row = ctx.sqlite.query("SELECT count(*) AS c FROM probe_windows WHERE provider = 'glm'").get() as { c: number } | null;
      if ((row?.c ?? 0) > 0) return { id: "glm", vendor: "opencode", homes: [] };
    } catch {
    }
  }
  const claudeId = claudeAccountId(ctx.claudeGauge?.subscription);
  if (ctx.claudeGauge?.plan && claudeId && wanted === claudeId.toLowerCase()) {
    return {
      id: claudeId,
      vendor: ctx.claudeGauge.vendor || "claude",
      homes: [],
    };
  }
  return null;
}

export function distinctSubscriptions(ctx: AppContext): SubscriptionAccount[] {
  const byId = new Map<string, SubscriptionAccount>();
  for (const sub of ctx.accounts.subscriptions || []) {
    if (normEraVendor(sub.vendor) === "claude" && !claudeAccountId(sub.id)) continue;
    const key = sub.id.toLowerCase();
    const first = byId.get(key);
    if (!first) {
      byId.set(key, { ...sub });
      continue;
    }
    if (!first.source_home) first.source_home = sub.source_home;
    if (!first.note) first.note = sub.note;
  }
  for (const account of ctx.codexDiscovery?.accounts ?? []) {
    if (!byId.has(account.id.toLowerCase())) byId.set(account.id.toLowerCase(), {
      id: account.id, vendor: "codex", home: "", account: account.email ?? undefined,
      note: "Account detected from a ChatGPT login. Historical transcripts require a source declaration.",
    });
  }
  for (const account of ctx.vendorDiscovery?.accounts ?? []) {
    if (normEraVendor(account.vendor) === "claude" && !claudeAccountId(account.id)) continue;
    if (!byId.has(account.id.toLowerCase())) byId.set(account.id.toLowerCase(), {
      id: account.id, vendor: account.vendor, home: "", account: account.email ?? undefined,
      note: "Automatically detected account. Historical traffic requires a source declaration.",
    });
  }
  return [...byId.values()];
}

export function knownAccountIds(ctx: AppContext): string[] {
  const ids = distinctSubscriptions(ctx).map((s) => s.id);
  const claudeId = claudeAccountId(ctx.claudeGauge?.subscription);
  if (ctx.claudeGauge?.plan && claudeId) ids.push(claudeId);
  try {
    const row = ctx.sqlite.query("SELECT count(*) AS c FROM probe_windows WHERE provider = 'glm'").get() as { c: number } | null;
    if ((row?.c ?? 0) > 0) ids.push("glm");
  } catch {
  }
  return ids;
}

type IndexedHomeTable = "events" | "ratelimit";

export function resolveIndexedHomes(
  ctx: AppContext,
  table: IndexedHomeTable,
  declared: string[]
): string[] {
  const want = new Set(declared.map(normPath));
  try {
    return codexTableHomes(ctx.sqlite, table).filter((home) => want.has(normPath(home)));
  } catch {
    return [];
  }
}

export function planLabel(sub: SubscriptionAccount, ctx: AppContext): string {
  if (sub.label?.trim()) return sub.label.trim();
  const homes = ctx.subIdToHomes.get(sub.id.toLowerCase()) ?? [];
  const logins = [...new Set(ctx.accounts.sources.filter(source => source.login && homes.some(home => normPath(home) === normPath(source.home)))
    .map(source => source.login!))];
  return logins.length === 1 ? `${sub.id} (${logins[0]})` : sub.id;
}
