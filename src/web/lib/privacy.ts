import { useSyncExternalStore } from "react";

const STORAGE_KEY = "tokenatlas.hide-identities";
const PUBLIC_LABELS = new Set(["all", "unknown", "unassigned", "none", "codex", "claude", "anthropic", "grok", "xai", "glm", "gemini", "opencode", "gauges", "openai", "pro", "plus", "free", "go", "max", "business", "enterprise", "edu", "lite", "ultra", "antigravity"]);
const PLAN_LABEL = /^(?:(?:codex|claude|chatgpt)[ -])?(?:pro|max|plus|business|enterprise|edu)(?:[ -]*(?:[x×]\d+|\d+[x×]))?$|^(?:[x×]\d+|\d+[x×])$/i;
const listeners = new Set<() => void>();
const identityListeners = new Set<() => void>();
let enabled = false;
try { enabled = typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* Memory-only preference. */ }
export const privacyEnabled = () => enabled;
export function setPrivacyEnabled(next: boolean) {
  enabled = next;
  try { localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* Memory-only preference. */ }
  for (const listener of listeners) listener();
}
export function onPrivacyChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function onPrivacyIdentities(listener: () => void) { identityListeners.add(listener); return () => { identityListeners.delete(listener); }; }
export function usePrivacy() { return useSyncExternalStore(onPrivacyChange, privacyEnabled, () => false); }

// Only presentation strings are replaced. IDs used in requests and calculations stay intact.
export class IdentityMask {
  private entries = new Set<string>();
  private pattern: RegExp | null = null;
  private dirty = true;
  get size() { return this.entries.size; }
  add(value: unknown): void {
    if (typeof value !== "string" || !value.trim() || PUBLIC_LABELS.has(value.toLowerCase()) || PLAN_LABEL.test(value)) return;
    if (!this.entries.has(value.toLowerCase())) {
      this.entries.add(value.toLowerCase());
      this.dirty = true;
    }
  }
  learn(value: unknown, context = ""): void {
    if (Array.isArray(value)) { for (const row of value) this.learn(row, context); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const account = "login" in row || "vendor_account" in row || "declared_account" in row || ("id" in row && "vendor" in row && /account|subscription/.test(context));
    const project = /^(projects|repos|subjects|repositories)$/.test(context) || row.kind === "project" || row.kind === "repo" || "matches" in row;
    if (account) this.add(row.id);
    if (project) { this.add(row.id); this.add(row.name); }
    if (context === "sources" && typeof row.name === "string" && /[\\/]/.test(row.name)) this.add(row.name.split(/[\\/]/).at(-1));
    for (const [key, item] of Object.entries(row)) {
      if (/^(account|account_id|subscription|subscription_id|vendor_account|declared_account|email|login|username|user_name|account_name)$/i.test(key)) this.add(item);
      if (/^(machine|machine_id|sourceMachine|hostname|host|store)$/i.test(key)) this.add(item);
      if (/^(project|project_id|project_name|repo|repo_id|repository)$/i.test(key)) this.add(item);
      if (/^(cwd|path|home|file|root|sourceArchiveRoot|databasePath|manifestPath)$/i.test(key)) this.add(item);
      this.learn(item, key);
    }
  }
  text(value: string): string {
    if (this.dirty) {
      const known = [...this.entries.keys()].sort((a, b) => b.length - a.length).map(raw => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const email = "[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\\.[A-Z0-9-]+)+";
      const path = "(?:[A-Z]:[\\\\/]|\\\\\\\\)[^\\s<>\"|]+|/(?:Users|home|mnt|Volumes)/[^\\s<>\"|]+";
      const uuid = "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b";
      this.pattern = new RegExp(`${email}|${path}|${uuid}${known ? `|(?<![\\p{L}\\p{N}_])(?:${known})(?![\\p{L}\\p{N}_])` : ""}`, "giu");
      this.dirty = false;
    }
    return value.replace(this.pattern!, "");
  }
}
const identities = new IdentityMask();
export function learnPrivacyIdentities(value: unknown) {
  const before = identities.size;
  identities.learn(value);
  if (identities.size !== before) for (const listener of identityListeners) listener();
}
export function privateText(value: string): string { return enabled ? identities.text(value) : value; }
export function reportImageFileName(value: string): string { return enabled ? `tokenatlas-private.${value.endsWith(".webp") ? "webp" : "png"}` : value; }

export function assertPrivacyWriteAllowed() {
  if (enabled) throw new Error("Privacy mode is read-only. Reveal identities before editing. / Tryb prywatności jest tylko do odczytu. Odkryj dane przed edycją.");
}
