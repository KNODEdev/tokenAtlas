import { createHash } from "node:crypto";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../../config/paths";
import type { SourceDeclaration } from "../archive-source";
import type { CurrentIdentity, SubscriptionDeclaration, SubscriptionLifecycle } from "../../web/lib/current-contract";

export interface CurrentConfig {
  subscriptions: SubscriptionDeclaration[];
  sources: SourceDeclaration[];
}

export function currentVendor(raw?: string): string {
  const value = raw?.trim().toLowerCase() || "codex";
  return ({ anthropic: "claude", openai: "codex", zai: "glm", "z.ai": "glm" } as Record<string, string>)[value] ?? value;
}
const LIFECYCLES = new Set<SubscriptionLifecycle>(["active", "paused", "cancelled", "unknown"]);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** Group declarations by subscription ID, never by e-mail, home or local login. */
export function currentRegistry(declarations: readonly SubscriptionDeclaration[], _now?: string): CurrentIdentity[] {
  const byId = new Map<string, SubscriptionDeclaration[]>();
  for (const declaration of declarations) {
    const id = text(declaration.id)?.toLowerCase();
    if (!id) continue;
    const bucket = byId.get(id) ?? [];
    bucket.push(declaration);
    byId.set(id, bucket);
  }
  return [...byId].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => {
    const vendors = new Set(rows.map((row) => currentVendor(row.vendor)));
    const accounts = new Set(rows.map((row) => text(row.account)).filter((value): value is string => value != null));
    const statuses = new Set(rows.map((row) => row.status).filter((value): value is SubscriptionLifecycle => value != null && LIFECYCLES.has(value)));
    const invalidStatus = rows.some((row) => row.status != null && !LIFECYCLES.has(row.status));
    const conflict = vendors.size !== 1 || accounts.size > 1 || statuses.size > 1 || invalidStatus;
    const account = !conflict && accounts.size === 1 ? [...accounts][0]! : null;
    return {
      id,
      vendor: vendors.size === 1 ? [...vendors][0]! : "unknown",
      label: text(rows.find((row) => text(row.label))?.label) ?? id,
      account_identity: account,
      identity_basis: account ? "declared" : "unknown",
      lifecycle: !conflict && statuses.size === 1 ? [...statuses][0]! : "unknown",
      // Source availability and subscription lifecycle remain independent.
      // The dated source binding is resolved when presenting a snapshot.
      binding_active: false,
      declaration_conflict: conflict,
    };
  });
}
export function registryFingerprint(registry: CurrentIdentity[]): string {
  return createHash("sha256").update(JSON.stringify(registry)).digest("hex");
}

/** Include physical source definitions; account labels do not identify a probe's archive folder. */
export function currentConfigFingerprint(registry: CurrentIdentity[], sources: readonly SourceDeclaration[],
  physical = { archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN }): string {
  const definitions = sources.map(({ vendor, machine, home, source_home }) =>
    [currentVendor(vendor), machine?.toLowerCase() ?? "", home?.toLowerCase() ?? "", source_home?.toLowerCase() ?? ""])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify([registryFingerprint(registry), physical.archiveRoot, physical.defaultLogin, definitions])).digest("hex");
}
