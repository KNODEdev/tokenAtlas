import type { Database } from "bun:sqlite";
import { archiveSourceKey, subscriptionRowSource } from "./event-source";
import { getVendorModelRate, normalizeRateVendor, type RateCard, type ModelRateAny, type RateBlock, type RateValues } from "./pricing";
import { disjointPromptInput, selectContextRates } from "../shared/context-tier";
import { vendorContextPremium } from "./vendor-context-premium";
import type { MeterEvent } from "./subscription-window-comparison";
import { classifyClaudeCodeEvent, type ClaudeCodeProductClass } from "../shared/claude-code-capacity";
import { GROK_TICKS_PER_USD } from "../shared/grok-usage";

export const TOKEN_BUCKETS = ["in_uncached", "in_cache_read", "in_cache_write_5m", "in_cache_write_1h", "in_cache_write_unknown", "out_total"] as const;
export type TokenBucket = typeof TOKEN_BUCKETS[number];
export type TokenQuantities = Record<TokenBucket, number> & { out_thinking: number };
type Row = Record<string, string | number | null>;
export interface SubscriptionEvent extends MeterEvent {
  identity: string;
  /**
   * Register version 8: the archive folder the row was recorded in (`claude/example-main`) and
   * the identity the session itself recorded, when it did (Claude `account_key`). These two are
   * all an event knows about who used it; `account` is filled in by a reader from the account
   * periods and is never stored (docs/register-v8-design-2026-09-22.md §1).
   */
  source: string | null;
  account_key: string | null;
  /** The source recorded two identities for one call (Claude `subscription_conflict`). */
  identity_conflict?: true;
  /**
   * Whether the row can be accounted under the provider's plan (`subscriptionRowEligible`). A
   * row that cannot is still recorded traffic: global usage prices it under `vendor`, the rate
   * vendor the row itself names.
   */
  eligible: boolean;
  vendor: string;
  source_id?: string;
  speed: string;
  quantities: TokenQuantities;
  precise_time: boolean;
  usage_valid?: boolean;
  /**
   * The provider billed the call from a promotional credit rather than the plan (Claude cloud `billing_mode = 'grant'`):
   * still recorded usage, but plan windows leave it out as funded, as they do Codex credits.
   */
  funding?: "grant";
  /**
   * Local provenance of the originating product, currently only for Claude. Absent on
   * providers with no such evidence. Deliberately not part of the usage fingerprint:
   * one copy missing its metadata must never discard the other copy's valid tokens.
   */
  product?: ClaudeCodeProductClass;
  /**
   * Local project/repo the call was made from; null when the source recorded neither.
   * Present for Claude, Grok and GLM from recorded columns only. Absent on providers with
   * no such evidence. Like `product`, it stays out of the usage fingerprint and out of the
   * valuation key: moving a call between projects corrects where its cost belongs, it does
   * not reprice or revalidate the tokens.
   */
  subject?: string | null;
  /**
   * Conversation the call belongs to; null when the source recorded none. Never derived
   * from the store, the account or the file path: unrelated calls without a session are
   * separate, not one shared session. Like `subject` it stays out of the usage fingerprint
   * and out of the valuation key, so recovering a session id corrects where activity is
   * bridged without repricing the tokens.
   */
  session?: string | null;
  /** Working repository of the call and its declared group, verbatim from recorded columns. */
  repo?: string | null;
  repo_group?: string | null;
  /**
   * Vendor-reported money, never mixed with the configured API-list valuation. Grok keeps
   * cost_ticks plus the documented assumed 1e9 conversion; GLM/OpenCode keeps cost USD.
   * Zero is a real zero; missing or invalid stays unknown. Out of the usage fingerprint
   * and the valuation key, so a money correction does not reprice unchanged tokens.
   */
  reported?: ReportedMoney;
}
/**
 * Bumped when the derivation below changes; only Claude's prepared fact scope depends on it. v2: the project of a subject
 * comes from the project rules at read time over the call's place (projects/rules-now.ts), not from a stored column.
 */
export const CLAUDE_SUBJECT_RULE = "claude-subject-v2";
/**
 * Bumped when the session/repository provenance below changes. Ready rows prepared before it
 * carry no session and no repository at all, so only Claude's scope is versioned by it.
 * Gemini keeps the same scope key; Grok and GLM version their own provenance rules.
 */
export const CLAUDE_PROVENANCE_RULE = "claude-provenance-v1";
/**
 * v1 added recorded subject/session/repo and vendor-reported ticks. v2 also requires the
 * stable row id and every Grok canonical-identity component, so old synthetic null identities
 * cannot survive in a ready scope. Claude, Gemini and GLM keep their own keys and valuations.
 */
export const GROK_PROVENANCE_RULE = "grok-provenance-v2";
/**
 * v1 added recorded subject/session/repo and OpenCode cost USD. v2 also requires the stable
 * row id and nonblank message id, so unrelated malformed rows cannot merge under one identity.
 * Claude, Gemini and Grok keep their own keys and valuations.
 */
export const GLM_PROVENANCE_RULE = "glm-provenance-v2";
export { GROK_TICKS_PER_USD } from "../shared/grok-usage";
export const GROK_REPORTED_PROVENANCE = "xai-cost-ticks-assumed-1e9";
export const GLM_REPORTED_PROVENANCE = "opencode-cost-usd";
export type ReportedMoneyUnit = "grok_ticks" | "oc_usd";
export interface ReportedMoney {
  /** Converted USD, or null when unknown or copies conflict. Never a manufactured charge. */
  usd: number | null;
  /** Original recorded value in `unit`, or null when missing, invalid or conflicting. */
  raw: number | null;
  unit: ReportedMoneyUnit;
  provenance: string;
  /** Live copies of the same tokens disagree on the reported amount. */
  conflict?: true;
}
/**
 * One provider of the shared usage ledger (docs/provider-contract.md §1): its fact table in native
 * categories and everything the shared layers need to read it. The ledger, the limit windows and the
 * screen readers ask the adapter; none of them names a provider.
 */
export interface SubscriptionAccountingAdapter {
  id: string;
  label: string;
  aliases: string[];
  /** The fact table, one row per call with a stable `id` and the call's `ts`. */
  table: string;
  /** The sync vendor whose sources fill `table` (GLM is read from OpenCode's): screen and reset scopes. */
  vendor: string;
  rateVendor: string;
  speed: boolean;
  /**
   * How a row's recorded mode (its `speed` column, null when absent) becomes the call's mode. Without
   * it the recorded value is kept and an absent one is unknown. `rule` names the normalization: it is
   * part of the rules digest, and a change re-reads only the facts whose stored mode it changes. It
   * must map an earlier stored mode to the same mode it gives the raw value that produced it.
   */
  speedNormalization?: { rule: string; normalize(recorded: string | null): string };
  opaqueSources?: readonly string[];
  defaultCounter: string;
  counterKinds: string[];
  defaultMinutes: Record<string, number>;
  counterIncludes(group: string | null, event: SubscriptionEvent): boolean;
  /** The native token columns in the ledger's categories; throws on counters that cannot be. */
  quantities(row: Row): TokenQuantities;
  /** The call's identity for deduplicating copies, or null when the source recorded an incomplete one. */
  eventIdentity(row: Row): string | null;
  /** Whether the row can be accounted under the plan at all (complete identity, a vendor inside the plan); default yes. */
  eligible?(row: Row): boolean;
  /** The identity the session itself recorded (Claude's `account_key`); a conflicting record names nobody. */
  sessionIdentity?(row: Row): { key: string | null; conflict: boolean };
  /** The source folder of a row; default the archive folder of its `path`. */
  source?(row: Row, archiveRoot: string): string | null;
  /** The rate vendor global usage prices this row under; default `rateVendor`. */
  rowRateVendor?(row: Row): string;
  /** The rate vendor an eligible call of `model` is valued under for global usage; default `rateVendor`. */
  modelRateVendor?(model: string | null): string;
  /**
   * The rate vendors this provider's valuations read: its own and those global usage prices its rows under;
   * `all` for a provider whose rows name any vendor (then also the Codex rules, for rows naming OpenAI).
   * Default: `rateVendor` alone.
   */
  valuationVendors?: readonly string[] | "all";
  /** Global usage keys models by the configured family a model extends (`modelRateKey`). */
  modelFamilyKeys?: true;
  /** Plan rates match a model by its configured family when there is no exact key. */
  modelFamilyRates?: true;
  /** Whether the row's counters are consistent with each other; default yes. */
  usageValid?(row: Row): boolean;
  /** Whether `ts` is the call's own instant (not a conversation's); default yes. */
  preciseTime?(row: Row): boolean;
  /** The source records project, repository and session columns. */
  recordsProvenance?: true;
  /** The originating product, where the source records it. */
  product?(row: Row): ClaudeCodeProductClass;
  /** Money the provider itself reported for the call. */
  reported?: { unit: ReportedMoneyUnit; provenance: string; read(row: Row): number | null };
  /**
   * The provider's amounts on the cards are the money it reported (`reported`), not a rate-card valuation, so a
   * model without a rate there is not a missing price (no missing-rate alert).
   */
  cardMoney?: "reported";
  /** The conversation a call belongs to in window usage. */
  windowSession?(event: Pick<SubscriptionEvent, "session" | "identity">): string | null;
  /** The table of the provider's limit refusals (calls the provider refused at 100%), read beside its readings. */
  limitHitTable?: string;
}
const n = (row: Row, field: string) => Number(row[field] ?? 0);
const str = (row: Row, field: string) => row[field] == null ? null : String(row[field]);
/**
 * Project evidence wins over repo evidence, and the prefix keeps the two kinds distinguishable
 * for callers that aggregate them. Values are kept verbatim so the subject of a row always
 * matches the raw project column the fact index filters on; only emptiness is judged on a trim.
 * Shared by Claude, Grok and GLM: the same recorded columns, never a guessed cwd or store.
 */
export function recordedEventSubject(row: Row): string | null {
  const project = str(row, "project_id");
  if (project !== null && project.trim() !== "") return `p:${project}`;
  const repo = str(row, "repo");
  return repo !== null && repo.trim() !== "" ? `r:${repo}` : null;
}
/** An absent or blank conversation id is unknown, never a bucket shared by unrelated calls. */
export function recordedEventSession(row: Row): string | null {
  const session = str(row, "session_id");
  return session !== null && session.trim() !== "" ? session : null;
}
function recordedProvenance(row: Row): Pick<SubscriptionEvent, "subject" | "session" | "repo" | "repo_group"> {
  return { subject: recordedEventSubject(row), session: recordedEventSession(row),
    repo: str(row, "repo"), repo_group: str(row, "repo_group") };
}
function parseReportedRaw(row: Row, field: string, ticks: boolean): number | null {
  const value = row[field];
  if (value == null || typeof value === "string" && value.trim() === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (ticks && !Number.isSafeInteger(amount)) return null;
  return amount;
}
/** How many of a reported unit make one USD. */
export const reportedUnitsPerUsd = (unit: ReportedMoneyUnit): number => unit === "grok_ticks" ? GROK_TICKS_PER_USD : 1;
export function reportedMoneyFromRaw(unit: ReportedMoneyUnit, provenance: string, raw: number | null): ReportedMoney {
  if (raw == null) return { usd: null, raw: null, unit, provenance };
  return { usd: raw / reportedUnitsPerUsd(unit), raw, unit, provenance };
}
/**
 * Combine vendor-reported money across live copies of one identity. Missing raw values are
 * ignored so they cannot erase a consistent present amount; disagreeing present amounts become
 * unknown with `conflict` rather than picking one copy. Token identity is decided elsewhere.
 */
export function mergeReportedMoney(canonical: ReportedMoney | undefined, copiesJson: string | null): ReportedMoney | undefined {
  if (!canonical) return canonical;
  let parsed: unknown = copiesJson ? JSON.parse(copiesJson) : [];
  if (!Array.isArray(parsed)) parsed = [];
  const present: ReportedMoney[] = [];
  for (const item of parsed as unknown[]) {
    const copy = typeof item === "string" ? JSON.parse(item) as Partial<ReportedMoney> : item as Partial<ReportedMoney> | null;
    if (!copy || typeof copy !== "object" || copy.raw == null) continue;
    const raw = typeof copy.raw === "number" ? copy.raw : Number(copy.raw);
    if (!Number.isFinite(raw) || raw < 0) continue;
    const unit = copy.unit === "grok_ticks" || copy.unit === "oc_usd" ? copy.unit : canonical.unit;
    present.push(reportedMoneyFromRaw(unit, typeof copy.provenance === "string" ? copy.provenance : canonical.provenance, raw));
  }
  if (present.length === 0) return { usd: null, raw: null, unit: canonical.unit, provenance: canonical.provenance };
  const key = (copy: ReportedMoney) => `${copy.unit}\0${copy.raw}`;
  const unique = [...new Map(present.map(copy => [key(copy), copy])).values()];
  if (unique.length > 1) {
    const units = new Set(unique.map(copy => copy.unit));
    return { usd: null, raw: null, unit: units.size === 1 ? unique[0]!.unit : canonical.unit,
      provenance: canonical.provenance, conflict: true };
  }
  return unique[0];
}
/** Ledger categories must be non-negative safe integers; anything else is an impossible counter. */
function validQuantities(provider: string, quantities: TokenQuantities): TokenQuantities {
  if (!Object.values(quantities).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error(`Invalid token quantities in ${provider} usage event`);
  return quantities;
}
const quantitiesOf = (provider: string, fresh: number, cached: number, write5: number, write1: number, writeUnknown: number,
  output: number, thinking: number): TokenQuantities => validQuantities(provider, { in_uncached: fresh, in_cache_read: cached,
    in_cache_write_5m: write5, in_cache_write_1h: write1, in_cache_write_unknown: writeUnknown, out_total: output, out_thinking: thinking });
export const GLM_SOURCE_PROVIDERS = ["zai-coding-plan","zhipuai-coding-plan","zai","zhipuai","z-ai"] as const;
const present = (row: Row, field: string) => row[field] != null && String(row[field]).trim() !== "";

/**
 * One source row as the fact index stores it. Every row is stored: an eligible one under the
 * provider's own event identity, so its copies deduplicate; an ineligible one (incomplete
 * identity, vendor outside the plan) under its own row id, so unrelated rows can never merge. It
 * carries the row's source and session identity, never an account: the reader resolves the
 * account from the periods (`AccountReadPlan`). Null only for a row with no usable timestamp.
 */
/** The mode of a call from the value its row records (null when absent), by the adapter's normalization. */
export function recordedSpeed(adapter: Pick<SubscriptionAccountingAdapter, "speed" | "speedNormalization">, recorded: string | null): string {
  if (adapter.speedNormalization) return adapter.speedNormalization.normalize(recorded);
  return recorded ?? (adapter.speed ? "unknown" : "standard");
}

/**
 * Claude's mode (user decision 06.10.2026): only an explicit Fast marker is Fast; a record without one
 * is Standard, a known mode. Claude Code's subagent transcripts omit `speed` (they carry
 * `service_tier: "standard"`) while main transcripts write `speed: "standard"`. A fact stored as
 * `unknown` under the earlier rule normalizes to Standard, as its absent raw value does.
 */
export const CLAUDE_SPEED_RULE = "claude-speed-absent-is-standard-v1";
const claudeSpeed = (recorded: string | null) => recorded === "fast" ? "fast" : "standard";

export function subscriptionEventFromRow(adapter: SubscriptionAccountingAdapter, row: Row, archiveRoot: string): SubscriptionEvent | null {
    if (row.ts == null) return null;
    const store = str(row, "store") ?? "";
    const ts = String(row.ts);
    const eligible = adapter.eligible?.(row) ?? true;
    // An impossible counter is recorded traffic whose quality the register reports, never a
    // reason to drop the row; the totals of such a row are zero and `usage_valid` says why.
    let quantities: TokenQuantities, usable = true;
    try { quantities = adapter.quantities(row); }
    catch { usable = false; quantities = { in_uncached: 0, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 0, out_thinking: 0 }; }
    const identity = eligible ? adapter.eventIdentity(row) ?? `row:${row.id}` : `row:${row.id}`;
    const recorded = adapter.sessionIdentity?.(row) ?? { key: null, conflict: false };
    const source = adapter.source ? adapter.source(row, archiveRoot) : archiveSourceKey(typeof row.path === "string" ? row.path : null, archiveRoot);
    return { account: null, source, account_key: recorded.key,
      ...(recorded.conflict ? { identity_conflict: true as const } : {}),
      eligible, vendor: adapter.rowRateVendor?.(row) ?? adapter.rateVendor,
      ts, model: str(row, "model"), home: store, identity, source_id: str(row,"source_id") ?? "",
      speed: recordedSpeed(adapter, str(row, "speed")), quantities,
      usage_valid: usable && (adapter.usageValid?.(row) ?? true),
      precise_time: adapter.preciseTime?.(row) ?? true,
      ...(row.billing_mode === "grant" ? { funding: "grant" as const } : {}),
      // Never derived from store, model or path: the collector also mirrors agent-mode
      // sessions, nested Code-style projects and audit journals into the same tables.
      ...(adapter.recordsProvenance ? recordedProvenance(row) : {}),
      ...(adapter.product ? { product: adapter.product(row) } : {}),
      ...(adapter.reported ? { reported: reportedMoneyFromRaw(adapter.reported.unit, adapter.reported.provenance, adapter.reported.read(row)) } : {}) };
}

/**
 * The configured model key global usage prices a model by when the adapter keys models by family.
 * Preserves the documented variant matching used by their ingestion: an exact key wins, otherwise the
 * longest configured family the model extends with a dash.
 */
export function modelRateKey(card: RateCard, vendor: string, model: string | null): string | null {
  if (!model) return null;
  const models = card.vendors[vendor]?.models ?? {};
  if (models[model]) return model;
  return Object.keys(models).filter(key => model.startsWith(key + "-")).sort((a, b) => b.length - a.length)[0] ?? model;
}

const allModels = () => true;
const nonEmpty = (row: Row, field: string): string | null =>
  row[field] == null || row[field] === "" ? null : String(row[field]);
const BUILT_IN: readonly SubscriptionAccountingAdapter[] = [
  { id: "claude", label: "Anthropic / Claude", aliases: ["claude", "anthropic"], table: "claude_events", vendor: "claude",
    rateVendor: "anthropic", speed: true, speedNormalization: { rule: CLAUDE_SPEED_RULE, normalize: claudeSpeed },
    opaqueSources: ["live", "desktop"],
    defaultCounter: "weekly_all", counterKinds: ["weekly_all", "session"], defaultMinutes: { weekly_all: 10080, session: 300 }, counterIncludes: allModels,
    quantities: row => {
      const write5 = n(row, "cache_write_5m"), write1 = n(row, "cache_write_1h");
      return quantitiesOf("claude", n(row, "in_uncached"), n(row, "in_cache_read"), write5, write1,
        Math.max(0, n(row, "in_cache_write") - write5 - write1), n(row, "out_total"), n(row, "out_thinking"));
    },
    eventIdentity: row => nonEmpty(row, "call_id"),
    sessionIdentity: row => {
      const conflict = n(row, "subscription_conflict") !== 0;
      return { key: conflict ? null : str(row, "account_key"), conflict };
    },
    usageValid: row => n(row, "in_cache_write") >= n(row, "cache_write_5m") + n(row, "cache_write_1h"),
    recordsProvenance: true,
    product: () => classifyClaudeCodeEvent(),
    valuationVendors: ["anthropic"], limitHitTable: "claude_limit_hits" },
  { id: "gemini", label: "Google / Gemini", aliases: ["gemini", "google"], table: "gemini_events", vendor: "gemini", rateVendor: "google", speed: false,
    defaultCounter: "weekly", counterKinds: ["weekly", "five_hour"], defaultMinutes: { weekly: 10080, five_hour: 300 }, counterIncludes: (group, event) => {
      const family = group?.toLowerCase() ?? "";
      const model = event.model?.toLowerCase() ?? "";
      return family.startsWith("gemini") ? model.startsWith("gemini") : family.startsWith("claude") ? model.startsWith("claude") : false;
    },
    quantities: row => quantitiesOf("gemini", n(row, "fresh_in"), n(row, "cached_in"), 0, 0, 0, n(row, "out_total"), n(row, "out_thinking")),
    eventIdentity: row => row.conversation_id != null && row.gen_idx != null ? JSON.stringify([row.conversation_id, row.gen_idx]) : null,
    rowRateVendor: row => nonEmpty(row, "model")?.startsWith("claude-") ? "anthropic" : "google",
    modelRateVendor: model => model?.startsWith("claude-") ? "anthropic" : "google", valuationVendors: ["google", "anthropic"],
    modelFamilyKeys: true,
    // Gemini records conversation times; only a row read from its own event has a precise instant.
    preciseTime: row => str(row, "ts_basis") === "event",
    // A call's identity is `[conversation, generation]`; an incomplete one (`row:<id>`) names no conversation.
    windowSession: event => {
      if (!event.identity.startsWith("[")) return null;
      try { const [conversation] = JSON.parse(event.identity) as unknown[]; return conversation == null ? null : String(conversation); }
      catch { return null; }
    } },
  { id: "grok", label: "xAI / Grok", aliases: ["grok", "xai"], table: "grok_events", vendor: "grok", rateVendor: "xai", speed: false,
    defaultCounter: "weekly", counterKinds: ["weekly", "session"], defaultMinutes: { weekly: 10080, session: 300 }, counterIncludes: allModels,
    quantities: row => {
      const cached = n(row, "cached_in");
      return quantitiesOf("grok", n(row, "in_tok") - cached, cached, 0, 0, n(row, "cache_write"), n(row, "out_tok"), n(row, "reasoning"));
    },
    eventIdentity: row => row.session_id != null && row.prompt_id != null ? JSON.stringify([row.session_id, row.prompt_id, row.model]) : null,
    eligible: row => ["id", "session_id", "prompt_id", "model"].every(field => present(row, field)),
    modelFamilyRates: true, recordsProvenance: true, cardMoney: "reported",
    reported: { unit: "grok_ticks", provenance: GROK_REPORTED_PROVENANCE, read: row => parseReportedRaw(row, "cost_ticks", true) } },
  { id: "glm", label: "Z.ai / GLM", aliases: ["glm", "zai", "z-ai"], table: "oc_events", vendor: "opencode", rateVendor: "zai", speed: false,
    defaultCounter: "weekly", counterKinds: ["weekly", "session"], defaultMinutes: { weekly: 10080, session: 300 }, counterIncludes: allModels,
    // OpenCode stores visible output separately from reasoning in this index.
    quantities: row => quantitiesOf("glm", n(row, "in_tok"), n(row, "cache_read"), 0, 0, n(row, "cache_write"),
      n(row, "out_tok") + n(row, "reasoning"), n(row, "reasoning")),
    eventIdentity: row => nonEmpty(row, "message_id"),
    eligible: row => (GLM_SOURCE_PROVIDERS as readonly string[]).includes(str(row, "provider")?.toLowerCase() ?? "")
      && present(row, "id") && present(row, "message_id"),
    source: (row, archiveRoot) => subscriptionRowSource("glm", row, archiveRoot),
    rowRateVendor: row => normalizeRateVendor(nonEmpty(row, "provider")) || "unknown", valuationVendors: "all",
    modelFamilyKeys: true, modelFamilyRates: true, recordsProvenance: true,
    reported: { unit: "oc_usd", provenance: GLM_REPORTED_PROVENANCE, read: row => parseReportedRaw(row, "cost", false) },
    windowSession: event => event.session ?? null },
];
const registry: SubscriptionAccountingAdapter[] = [...BUILT_IN];
/** The providers of the shared usage ledger: the built-in ones and any registered after them. */
export function subscriptionAccountingAdapters(): readonly SubscriptionAccountingAdapter[] { return registry; }
/** The ledger providers' ids, in registration order. */
export const usageLedgerProviderIds = (): string[] => registry.map(adapter => adapter.id);
/** Every provider with usage and limit windows: Codex (its own price ledger) and the shared-ledger providers. */
export const usageProviderIds = (): string[] => ["codex", ...usageLedgerProviderIds()];
/** The table of a provider's limit refusals, if its adapter declares one. */
export const limitHitTableOf = (provider: string): string | undefined => ledgerProviderOf(provider)?.limitHitTable;
/** The built-in providers, which the migrations' per-provider indexes name. */
export const BUILT_IN_LEDGER_PROVIDERS: readonly string[] = BUILT_IN.map(adapter => adapter.id);
/**
 * Adds a provider to the shared layers (a new provider's adapter module, or a test). Returns the
 * function that removes it again.
 */
export function registerSubscriptionAccountingAdapter(adapter: SubscriptionAccountingAdapter): () => void {
  if (registry.some(existing => existing.id === adapter.id || existing.aliases.some(alias => adapter.aliases.includes(alias))))
    throw new Error(`Provider '${adapter.id}' is already registered`);
  registry.push(adapter);
  return () => { const index = registry.indexOf(adapter); if (index >= 0) registry.splice(index, 1); };
}
export function subscriptionAccountingAdapter(provider: string) {
  const adapter = registry.find(a => a.aliases.includes(provider.toLowerCase()));
  if (!adapter) throw new Error(`No subscription accounting adapter for '${provider}'`);
  return adapter;
}
/** The ledger provider a provider name, alias or sync vendor denotes, or null (Codex, unknown). */
export function ledgerProviderOf(name: string): SubscriptionAccountingAdapter | null {
  const key = name.toLowerCase();
  return registry.find(adapter => adapter.aliases.includes(key) || adapter.vendor === key) ?? null;
}

export const PROVIDER_MODEL_RATE_RULE = "grok-glm-configured-model-family-v1";
/** Rate vendors whose plan rates match a model by its configured family (the adapters that say so). */
const familyRateVendor = (vendor: string) => registry.some(adapter => adapter.modelFamilyRates && adapter.rateVendor === vendor);
export function providerModelRateRules(adapter: Pick<SubscriptionAccountingAdapter, "rateVendor">): string[] {
  return familyRateVendor(adapter.rateVendor) ? [PROVIDER_MODEL_RATE_RULE] : [];
}
export function configuredSubscriptionModel(card: RateCard, vendor: string, model: string | null) {
  const exact = card.vendors[vendor]?.models?.[model ?? ""];
  if (exact) return exact;
  return familyRateVendor(vendor) ? getVendorModelRate(card, vendor, model) ?? undefined : undefined;
}

/** The card's key of the model entry `configuredSubscriptionModel` resolves, or null for none. */
export function configuredSubscriptionModelKey(card: RateCard, vendor: string, model: string | null): string | null {
  const entry = configuredSubscriptionModel(card, vendor, model);
  if (!entry) return null;
  for (const [key, candidate] of Object.entries(card.vendors[normalizeRateVendor(vendor) || vendor]?.models ?? {}))
    if (candidate === entry) return key;
  for (const [key, candidate] of Object.entries(card.vendors[vendor]?.models ?? {})) if (candidate === entry) return key;
  return null;
}

/**
 * How actual-mode valuations price a call whose mode stays undetermined after the provider's mode
 * normalization (user decision 06.10.2026): at the Standard rate, a lower bound. Claude normalizes every
 * record to a known mode (`CLAUDE_SPEED_RULE`), so this applies to providers whose records leave it open. The call is priced, not unpriced; its unknown speed
 * stays recorded and the quality measures report it (`unknown_speed_tokens`, the `unknown_mode` flag).
 * It is part of the rules digest of providers that record a mode and of the ledger's rate keys for an
 * unknown mode, so a change of the rule revalues exactly those facts.
 */
export const UNKNOWN_MODE_RATE_RULE = "unknown-mode-standard-lower-bound-v1";

export type SubscriptionRateEvent = Pick<SubscriptionEvent, "model" | "ts" | "speed"> & {
  quantities?: Pick<TokenQuantities, TokenBucket>;
};

/** Prompt input of one call: every disjoint input bucket, never output or thinking; null when not a valid count. */
export function subscriptionPromptInput(event: SubscriptionRateEvent): number | null {
  const q = event.quantities;
  return q ? disjointPromptInput([q.in_uncached, q.in_cache_read, q.in_cache_write_5m, q.in_cache_write_1h, q.in_cache_write_unknown]) : null;
}

/**
 * The dated rate one event is valued with: the configured model (exact key, or the configured
 * family for xAI/Z.ai), its `after` rates past `until`, its `fast` rates in actual mode, and the
 * context tier of the chosen block for the call's prompt size (a model may have none). The tier's
 * rates apply only while the vendor's premium is on; the band is reported either way, and
 * `baseRates`/`longRates` let a view measure the uplift the setting leaves out or adds.
 */
export function subscriptionRateSelection(card: RateCard, adapter: Pick<SubscriptionAccountingAdapter, "rateVendor" | "speed">,
  event: SubscriptionRateEvent, standard = false, referenceDay?: string) {
  const model = configuredSubscriptionModel(card, adapter.rateVendor, event.model);
  let block: RateBlock | undefined = model;
  const after = !!model?.until && (referenceDay ?? event.ts.slice(0, 10)) > model.until && (!!model.after || referenceDay !== undefined);
  if (after) block = model!.after;
  if (!standard && event.speed === "fast") block = model?.fast;
  const context = selectContextRates<RateValues>(block, block?.long_context, model?.long_context, subscriptionPromptInput(event));
  const premium = vendorContextPremium(card, adapter.rateVendor);
  // Without the premium a long or unsized request is at the block's base rates.
  const rate = premium || context.band === null || context.band === "base" ? context.rates : block;
  const unknownMode = !standard && adapter.speed && event.speed !== "fast" && event.speed !== "standard";
  return { rate, unknownMode, after, contextBand: context.band, contextThreshold: context.threshold, contextPremium: premium,
    baseRates: block, longRates: block?.long_context?.rates };
}

/** The context band `subscriptionRateSelection` chooses for an event; null for a model without a tier. */
export function subscriptionContextBand(card: RateCard, adapter: Pick<SubscriptionAccountingAdapter, "rateVendor" | "speed">,
  event: SubscriptionRateEvent, standard = false) {
  return subscriptionRateSelection(card, adapter, event, standard).contextBand;
}

export function priceSubscriptionEvent(card: RateCard, adapter: Pick<SubscriptionAccountingAdapter, "rateVendor" | "speed">, event: SubscriptionEvent, standard = false, referenceDay?: string) {
  const vendor = card.vendors[adapter.rateVendor];
  const { rate, unknownMode } = subscriptionRateSelection(card, adapter, event, standard, referenceDay);
  const rates: Record<string, number | null> = {}, costs: Record<string, number | null> = {};
  // An event that records no tokens costs exactly zero whatever the card says, so a missing
  // rate must not turn it into "unpriced" and drag a whole report down with it.
  let total = 0, complete = true, subtotal = 0;
  for (const key of TOKEN_BUCKETS) {
    const field = key === "in_cache_write_unknown" ? "in_cache_write" : key;
    const raw = rate?.[field as keyof typeof rate];
    const value = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
    rates[key] = value;
    costs[key] = event.quantities[key] === 0 ? 0 : value === null ? null : event.quantities[key] * value / 1e6;
    if (costs[key] === null) complete = false;
    else { total += costs[key]!; subtotal += costs[key]!; }
  }
  if (event.usage_valid === false) { complete = false; subtotal = 0; }
  return { amount: complete ? total : null, subtotal, rates, costs, source: vendor?.source ?? null,
    reason: complete ? null : event.usage_valid === false ? "invalid_cache_totals" as const : "missing_rate" as const,
    note: event.usage_valid === false ? "Conflicting cache totals in source usage; original counters retained"
      : complete && unknownMode ? "The event does not record its mode; valued at Standard rates, a lower bound (mode unconfirmed)"
      : !rate && !complete ? "Missing model or mode rate" : !complete ? "Missing rate for a nonzero token bucket"
      : !rate ? "No model or mode rate, but the event records no tokens, so its cost is exactly zero"
      : "Configured dated rates; API equivalent, not a subscription charge" };
}
