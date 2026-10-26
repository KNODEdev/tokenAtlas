import fs from "node:fs";
import { withContextRates } from "./rate-cards-file";
import { createHash, randomUUID } from "node:crypto";
import { configWriteTarget } from "../config/paths";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { convertLegacyCodexLedgerPolicy, validateCodexLedgerPolicy, ledgerTierMultiplier,
  type CodexLedgerPolicy, type LedgerBaseRule, type LedgerBillingBasis,
  type LedgerTierMapping, type LedgerTierRule, type LedgerRates } from "./codex-ledger-policy";
import { decimal, multiply, NANO_BUCKETS, type Rational } from "../db/price-ledger-exact";
import type { RateCard } from "./pricing";

const HISTORY_LIMIT = 32;
type Rule = LedgerBaseRule | LedgerTierRule | LedgerTierMapping;
type Collection = "base_rules" | "tier_rules" | "mappings";
interface EditRecord {
  token: string; before_revision: string; after_revision: string; origin: "user";
  updated_at: string; note?: string; before: CodexLedgerPolicy; after: CodexLedgerPolicy;
  undo_of?: string;
}
export interface CodexLedgerDeclarationHistory {
  version: 1; generation: number; original: CodexLedgerPolicy; edits: EditRecord[];
}
export interface CodexLedgerSettingsPolicy extends CodexLedgerPolicy {
  declaration_history?: CodexLedgerDeclarationHistory;
}
export interface CodexLedgerSettings {
  revision: string; semantic_revision: string; policy: CodexLedgerPolicy;
  updated_at?: string; undo: { token: string; updated_at: string; note?: string; undo_of?: string }[];
}
export type CodexLedgerOperation =
  | { kind: "upsert_base_rule" | "overlay_base_rule"; rule: LedgerBaseRule; replace_id?: string }
  | { kind: "upsert_tier_rule" | "overlay_tier_rule"; rule: LedgerTierRule; replace_id?: string }
  | { kind: "upsert_mapping" | "overlay_mapping"; mapping: LedgerTierMapping; replace_id?: string }
  | { kind: "remove_base_rule" | "remove_tier_rule" | "remove_mapping"; id: string }
  | { kind: "add_tier" | "remove_tier"; tier: string }
  | { kind: "set_long_context_premium"; enabled: boolean };
export interface CodexLedgerEdit {
  expected_revision: string; operations: CodexLedgerOperation[]; origin: "user"; note?: string;
}
export interface CodexLedgerUndo {
  expected_revision: string; undo_token: string; origin: "user"; note?: string;
}
export interface CodexLedgerDependency {
  side: "before" | "after"; model?: string; billing_basis?: LedgerBillingBasis;
  tier?: string; raw_value?: string; valid_from?: string; valid_until?: string;
  input_above_tokens?: number; include_unpriced: true;
  input_at_most_tokens?: number;
}
export interface CodexLedgerEffects {
  base_reprice: CodexLedgerDependency[];
  derivative_regroup: CodexLedgerDependency[];
  derivative_reread: CodexLedgerDependency[];
}
export interface PreparedCodexLedgerChange {
  card: RateCard; settings: CodexLedgerSettings; effects: CodexLedgerEffects;
  changed: boolean; undo_token?: string;
}
export class CodexLedgerRevisionConflict extends Error {
  constructor() { super("Codex ledger policy changed; refresh before saving."); this.name = "CodexLedgerRevisionConflict"; }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function plain(policy: CodexLedgerSettingsPolicy): CodexLedgerPolicy {
  const { declaration_history: _history, ...rest } = structuredClone(policy);
  return rest;
}
function validateSettingsPolicy(value: unknown): asserts value is CodexLedgerPolicy {
  validateCodexLedgerPolicy(value);
  if (value.tiers.some(tier => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(tier))) throw new Error("Invalid tier identity");
  for (const rule of [...value.base_rules, ...value.tier_rules]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(rule.model) || rule.id.length > 1024 || rule.sources.length > 20
      || rule.sources.some(source => {
        try { const url = new URL(source); return url.protocol !== "https:" || !url.hostname || !!url.username || !!url.password || source.length > 4000; }
        catch { return true; }
      })) throw new Error("Invalid ledger identity or HTTPS provenance");
  }
  if (value.mappings.some(mapping => mapping.id.length > 1024 || mapping.raw_value.length > 512)) throw new Error("Invalid raw-tier mapping identity");
}
function history(policy: CodexLedgerSettingsPolicy): CodexLedgerDeclarationHistory | undefined {
  const value = policy.declaration_history;
  if (!value) return undefined;
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Array.isArray(value.edits) || value.edits.length > HISTORY_LIMIT) throw new Error("Invalid ledger declaration history");
  validateSettingsPolicy(value.original);
  const tokens = new Set<string>();
  for (const edit of value.edits) {
    if (!edit || typeof edit.token !== "string" || !edit.token || tokens.has(edit.token)
      || edit.origin !== "user" || !/^\d{4}-\d{2}-\d{2}T/.test(edit.updated_at)
      || !Number.isFinite(Date.parse(edit.updated_at))
      || !/^[a-f0-9]{64}$/.test(edit.before_revision) || !/^[a-f0-9]{64}$/.test(edit.after_revision)
      || edit.note !== undefined && (typeof edit.note !== "string" || edit.note.length > 2000)) throw new Error("Invalid ledger declaration record");
    tokens.add(edit.token); validateSettingsPolicy(edit.before); validateSettingsPolicy(edit.after);
  }
  if (!value.edits.length || value.generation < value.edits.length) throw new Error("Invalid ledger declaration generation");
  for (let index = 0; index < value.edits.length; index++) {
    const edit = value.edits[index]!, generation = value.generation - value.edits.length + index + 1;
    if (edit.before_revision !== hash({ policy: edit.before, generation: generation - 1 })
      || edit.after_revision !== hash({ policy: edit.after, generation })
      || index > 0 && !same(value.edits[index - 1]!.after, edit.before)) throw new Error("Ledger declaration history is inconsistent");
  }
  if (!same(value.edits.at(-1)!.after, plain(policy))) throw new Error("Ledger policy does not match its latest declaration");
  return structuredClone(value);
}
/** The legacy adapter uses the existing fallback contract and never repairs decimal artifacts. */
export function readCodexLedgerPolicy(card: RateCard): CodexLedgerPolicy {
  const policy = card.codex_ledger_policy === undefined
    ? convertLegacyCodexLedgerPolicy(resolveCodexAccountingConfig(card)) : card.codex_ledger_policy;
  validateSettingsPolicy(policy); history(policy);
  return plain(policy);
}
export function codexLedgerSettings(card: RateCard): CodexLedgerSettings {
  const policy = readCodexLedgerPolicy(card), declared = card.codex_ledger_policy && history(card.codex_ledger_policy);
  const semantic = { long_context_premium: policy.long_context_premium !== false, tiers: [...policy.tiers].sort(),
    ...Object.fromEntries(collections.map(key => [key, semanticRules(policy[key] as Rule[], policy.long_context_premium !== false)])) };
  return { policy, revision: hash({ policy, generation: declared?.generation ?? 0 }), semantic_revision: hash(semantic),
    ...(declared?.edits.length ? { updated_at: declared.edits.at(-1)!.updated_at } : {}),
    undo: (declared?.edits ?? []).map(({ token, updated_at, note, undo_of }) => ({ token, updated_at, note, undo_of })) };
}
function validateRequest(request: CodexLedgerEdit | CodexLedgerUndo, revision: string): void {
  if (!request || request.origin !== "user" || typeof request.expected_revision !== "string"
    || request.note !== undefined && (typeof request.note !== "string" || request.note.length > 2000)) throw new Error("Invalid ledger declaration");
  if (request.expected_revision !== revision) throw new CodexLedgerRevisionConflict();
}
const collections: Collection[] = ["base_rules", "tier_rules", "mappings"];
function collection(kind: string): Collection {
  return kind.endsWith("base_rule") ? "base_rules" : kind.endsWith("tier_rule") ? "tier_rules" : "mappings";
}
function subject(rule: Rule): string {
  return "raw_value" in rule ? canonical([rule.raw_value]) : canonical([rule.model, rule.billing_basis,
    ...("tier" in rule ? [rule.tier] : [])]);
}
function overlaps(a: Rule, b: Rule): boolean {
  return (!a.valid_from || !b.valid_until || a.valid_from < b.valid_until)
    && (!b.valid_from || !a.valid_until || b.valid_from < a.valid_until);
}
function validateOperation(op: CodexLedgerOperation): void {
  if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.kind !== "string") throw new Error("Invalid ledger operation");
  const payload = op as unknown as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    upsert_base_rule: ["rule", "replace_id"], overlay_base_rule: ["rule", "replace_id"],
    upsert_tier_rule: ["rule", "replace_id"], overlay_tier_rule: ["rule", "replace_id"],
    upsert_mapping: ["mapping", "replace_id"], overlay_mapping: ["mapping", "replace_id"],
    remove_base_rule: ["id"], remove_tier_rule: ["id"], remove_mapping: ["id"],
    add_tier: ["tier"], remove_tier: ["tier"], set_long_context_premium: ["enabled"],
  };
  const allowed = fields[op.kind];
  if (!allowed || Object.keys(payload).some(key => key !== "kind" && !allowed.includes(key))) throw new Error("Invalid ledger operation payload");
  const required = allowed[0]!, value = payload[required];
  if (required === "rule" || required === "mapping") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ledger operation rule");
  } else if (required === "enabled" ? typeof value !== "boolean" : typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid ledger operation value");
  }
  if (payload.replace_id !== undefined && (typeof payload.replace_id !== "string" || !payload.replace_id.trim())) {
    throw new Error("Invalid ledger operation replacement identity");
  }
}
function apply(policy: CodexLedgerPolicy, op: CodexLedgerOperation): void {
  validateOperation(op);
  if (op.kind === "add_tier") { if (!policy.tiers.includes(op.tier)) policy.tiers.push(op.tier); return; }
  if (op.kind === "remove_tier") {
    if (!policy.tiers.includes(op.tier)) throw new Error("Unknown tier identity");
    policy.tiers = policy.tiers.filter(t => t !== op.tier); return;
  }
  if (op.kind === "set_long_context_premium") { policy.long_context_premium = op.enabled; return; }
  const kinds = ["upsert_base_rule", "overlay_base_rule", "upsert_tier_rule", "overlay_tier_rule",
    "upsert_mapping", "overlay_mapping", "remove_base_rule", "remove_tier_rule", "remove_mapping"];
  if (!kinds.includes(op.kind)) throw new Error("Unknown ledger operation");
  const key = collection(op.kind), current = policy[key] as Rule[];
  if (op.kind === "remove_base_rule" || op.kind === "remove_tier_rule" || op.kind === "remove_mapping") {
    if (!current.some(rule => rule.id === op.id)) throw new Error("Unknown ledger rule identity");
    (policy[key] as Rule[]) = current.filter(rule => rule.id !== op.id); return;
  }
  if (!("rule" in op) && !("mapping" in op)) throw new Error("Missing ledger rule");
  const incoming = structuredClone("rule" in op ? op.rule : op.mapping);
  if (!incoming || typeof incoming !== "object") throw new Error("Invalid ledger rule");
  if (op.kind.startsWith("upsert_") && (!op.replace_id || op.replace_id === incoming.id)
    && same(current.find(rule => rule.id === incoming.id), incoming)) return;
  if ("confidence" in incoming) incoming.confidence = "user";
  if (op.replace_id && !current.some(rule => rule.id === op.replace_id)) throw new Error("Unknown replacement identity");
  const overlay = op.kind.startsWith("overlay_");
  let next = current.filter(rule => overlay
    ? !op.replace_id || rule.id !== op.replace_id || subject(rule) === subject(incoming)
    : rule.id !== (op.replace_id ?? incoming.id));
  if (overlay) next = next.flatMap(rule => {
    if (subject(rule) !== subject(incoming) || !overlaps(rule, incoming)) return [rule];
    const parts: Rule[] = [];
    if (incoming.valid_from && (!rule.valid_from || rule.valid_from < incoming.valid_from)) {
      parts.push({ ...rule, id: rule.id === incoming.id ? `${rule.id}:split:${randomUUID()}` : rule.id,
        valid_until: incoming.valid_from });
    }
    if (incoming.valid_until && (!rule.valid_until || incoming.valid_until < rule.valid_until)) {
      parts.push({ ...rule, id: parts.length || rule.id === incoming.id ? `${rule.id}:split:${randomUUID()}` : rule.id, valid_from: incoming.valid_until });
    }
    return parts;
  });
  next.push(incoming); (policy[key] as Rule[]) = next;
}
const exact = (value: Rational) => [value.n.toString(), value.d.toString()];
function effectiveRates(rates: LedgerRates, multiplier: string): unknown {
  return Object.fromEntries(NANO_BUCKETS.map(key => [key, rates[key] == null ? null
    : exact(multiply(decimal(rates[key]!), decimal(multiplier)))]));
}
function calculation(rule: Rule, premium = true): unknown {
  if ("raw_value" in rule) return { raw_value: rule.raw_value, tier: rule.tier };
  const identity = { model: rule.model, billing_basis: rule.billing_basis };
  if ("rates" in rule) return { ...identity, rates: effectiveRates(rule.rates, rule.multiplier),
    ...(premium && rule.long_context ? { long_context: { above_input_tokens: rule.long_context.above_input_tokens,
      rates: effectiveRates(rule.long_context.rates, rule.multiplier) } } : {}) };
  return { ...identity, tier: rule.tier, multiplier: exact(ledgerTierMultiplier(rule.multiplier)), included_usage: rule.included_usage };
}
/** Adjacent equivalent portions are one interpretation even when overlays split their declaration IDs. */
function semanticRules(rules: Rule[], premium: boolean) {
  const segments: Array<{ subject: string; values: unknown; valid_from?: string; valid_until?: string }> = [];
  for (const rule of [...rules].sort((a, b) => subject(a).localeCompare(subject(b)) || (a.valid_from ?? "").localeCompare(b.valid_from ?? ""))) {
    const next = { subject: subject(rule), values: calculation(rule, premium), valid_from: rule.valid_from, valid_until: rule.valid_until };
    const last = segments.at(-1);
    if (last && last.subject === next.subject && last.valid_until === next.valid_from && same(last.values, next.values)) last.valid_until = next.valid_until;
    else segments.push(next);
  }
  return segments;
}
function baseContextChanges(rule: LedgerBaseRule, matching: LedgerBaseRule, premium: boolean, otherPremium: boolean) {
  const context = (current: LedgerBaseRule, enabled: boolean) => enabled ? current.long_context : undefined;
  const left = context(rule, premium), right = context(matching, otherPremium);
  const cuts = [...new Set([0, ...(left ? [left.above_input_tokens] : []), ...(right ? [right.above_input_tokens] : []), Infinity])].sort((a, b) => a - b);
  const changes: Array<{ lower: number; upper: number }> = [];
  const value = (current: LedgerBaseRule, active: LedgerBaseRule["long_context"], lower: number) => {
    const long = active && lower >= active.above_input_tokens;
    return { band: long ? "long" : "normal", rates: effectiveRates(long ? active.rates : current.rates, current.multiplier) };
  };
  for (let index = 0; index < cuts.length - 1; index++) {
    const lower = cuts[index]!, upper = cuts[index + 1]!;
    if (same(value(rule, left, lower), value(matching, right, lower))) continue;
    const last = changes.at(-1);
    if (last?.upper === lower) last.upper = upper;
    else changes.push({ lower, upper });
  }
  return changes.map(({ lower, upper }) => ({ ...(lower > 0 ? { input_above_tokens: lower } : {}),
    ...(Number.isFinite(upper) ? { input_at_most_tokens: upper } : {}) }));
}
function dependency(rule: Rule, side: "before" | "after"): CodexLedgerDependency {
  return { side, ...("raw_value" in rule ? { raw_value: rule.raw_value, tier: rule.tier }
    : { model: rule.model, billing_basis: rule.billing_basis, ...("tier" in rule ? { tier: rule.tier } : {}) }),
    ...(rule.valid_from ? { valid_from: rule.valid_from } : {}), ...(rule.valid_until ? { valid_until: rule.valid_until } : {}),
    include_unpriced: true };
}
/** Select by model/raw evidence and period, including missing-rule cohorts; never by saved rule ID. */
export function previewCodexLedgerEffects(before: CodexLedgerPolicy, after: CodexLedgerPolicy): CodexLedgerEffects {
  validateCodexLedgerPolicy(before); validateCodexLedgerPolicy(after);
  const effects: CodexLedgerEffects = { base_reprice: [], derivative_regroup: [], derivative_reread: [] };
  for (const key of collections) for (const side of ["before", "after"] as const) {
    const current = (side === "before" ? before : after)[key] as Rule[];
    const other = (side === "before" ? after : before)[key] as Rule[];
    for (const rule of current) {
      const start = rule.valid_from ?? "", end = rule.valid_until ?? "~";
      const related = other.filter(candidate => subject(candidate) === subject(rule) && overlaps(rule, candidate));
      const cuts = [...new Set([start, end, ...related.flatMap(candidate => [candidate.valid_from ?? "", candidate.valid_until ?? "~"])
        .filter(day => day > start && day < end)])].sort();
      for (let index = 0; index < cuts.length - 1; index++) {
        const from = cuts[index]!, until = cuts[index + 1]!;
        const matching = related.find(candidate => (candidate.valid_from ?? "") <= from && (candidate.valid_until ?? "~") >= until);
        const policy = side === "before" ? before : after, otherPolicy = side === "before" ? after : before;
        if (matching && same(calculation(rule, policy.long_context_premium !== false), calculation(matching, otherPolicy.long_context_premium !== false))) continue;
        const dep = dependency({ ...rule, valid_from: from || undefined, valid_until: until === "~" ? undefined : until } as Rule, side);
        if (key === "base_rules") {
          const contexts = matching ? baseContextChanges(rule as LedgerBaseRule, matching as LedgerBaseRule,
            policy.long_context_premium !== false, otherPolicy.long_context_premium !== false) : [{}];
          for (const context of contexts) { const scoped = { ...dep, ...context }; effects.base_reprice.push(scoped); effects.derivative_reread.push(scoped); }
        }
        else if (key === "mappings") effects.derivative_regroup.push(dep);
        else effects.derivative_reread.push(dep);
      }
    }
  }
  for (const key of Object.keys(effects) as (keyof CodexLedgerEffects)[]) {
    effects[key] = [...new Map(effects[key].map(dep => [canonical(dep), dep])).values()];
  }
  return effects;
}
function finish(card: RateCard, before: CodexLedgerSettings, proposed: CodexLedgerPolicy,
  request: CodexLedgerEdit | CodexLedgerUndo, options: { now?: string }, undoOf?: string): PreparedCodexLedgerChange {
  validateSettingsPolicy(proposed);
  const effects = previewCodexLedgerEffects(before.policy, proposed);
  if (same(before.policy, proposed)) return { card, settings: before, effects, changed: false };
  const updatedAt = options.now ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Invalid declaration timestamp");
  const prior = card.codex_ledger_policy && history(card.codex_ledger_policy);
  const generation = (prior?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("Ledger declaration generation exhausted");
  const token = randomUUID();
  const entry: EditRecord = { token, before_revision: before.revision, after_revision: hash({ policy: proposed, generation }),
    origin: "user", updated_at: updatedAt, ...(request.note !== undefined ? { note: request.note } : {}),
    before: structuredClone(before.policy), after: structuredClone(proposed), ...(undoOf ? { undo_of: undoOf } : {}) };
  const next: RateCard = { ...card, codex_ledger_policy: { ...proposed, declaration_history: {
    version: 1, generation, original: prior?.original ?? structuredClone(before.policy),
    edits: [...(prior?.edits ?? []), entry].slice(-HISTORY_LIMIT),
  } } };
  return { card: next, settings: codexLedgerSettings(next), effects, changed: true, undo_token: token };
}
export function prepareCodexLedgerEdit(card: RateCard, edit: CodexLedgerEdit,
  options: { now?: string } = {}): PreparedCodexLedgerChange {
  const before = codexLedgerSettings(card); validateRequest(edit, before.revision);
  if (!Array.isArray(edit.operations) || !edit.operations.length || edit.operations.length > 128) throw new Error("Expected 1–128 ledger operations");
  const proposed = structuredClone(before.policy);
  for (const operation of edit.operations) apply(proposed, operation);
  return finish(card, before, proposed, edit, options);
}
/** A scoped compatibility editor supplies a complete validated snapshot while retaining untouched provenance. */
export function prepareCodexLedgerPolicyChange(card: RateCard, proposed: CodexLedgerPolicy,
  request: Pick<CodexLedgerEdit, "expected_revision" | "origin" | "note">, options: { now?: string } = {}): PreparedCodexLedgerChange {
  const before = codexLedgerSettings(card); validateRequest(request as CodexLedgerEdit, before.revision);
  return finish(card, before, structuredClone(proposed), request as CodexLedgerEdit, options);
}
function declaration(rule: Rule | undefined): unknown {
  if (!rule) return undefined;
  const { id: _id, valid_from: _from, valid_until: _until, ...value } = rule;
  return value;
}
function restoreTemporalCollection(previous: Rule[], applied: Rule[], current: Rule[], touched: Set<string>): Rule[] {
  const subjects = new Set([...previous, ...applied].filter(rule => touched.has(rule.id)).map(subject));
  const restored = current.filter(rule => !subjects.has(subject(rule)));
  for (const key of subjects) {
    const old = previous.filter(rule => subject(rule) === key), expected = applied.filter(rule => subject(rule) === key), now = current.filter(rule => subject(rule) === key);
    const cuts = [...new Set(["", "~", ...[...old, ...expected, ...now].flatMap(rule => [rule.valid_from ?? "", rule.valid_until ?? "~"])])].sort();
    const cover = (rules: Rule[], from: string, until: string) => rules.find(rule => (rule.valid_from ?? "") <= from && (rule.valid_until ?? "~") >= until);
    const pieces: Rule[] = [];
    for (let index = 0; index < cuts.length - 1; index++) {
      const from = cuts[index]!, until = cuts[index + 1]!;
      const before = cover(old, from, until), after = cover(expected, from, until), present = cover(now, from, until);
      const changed = !same(declaration(before), declaration(after));
      if (changed && !same(declaration(present), declaration(after))) throw new Error("Undo conflicts with a later declaration");
      const chosen = changed ? before : present;
      if (!chosen) continue;
      const piece = { ...structuredClone(chosen), valid_from: from || undefined, valid_until: until === "~" ? undefined : until } as Rule;
      const last = pieces.at(-1);
      if (last && last.valid_until === piece.valid_from && same(declaration(last), declaration(piece))) last.valid_until = piece.valid_until;
      else pieces.push(piece);
    }
    restored.push(...pieces);
  }
  const ids = new Set<string>();
  for (const rule of restored) {
    if (ids.has(rule.id)) rule.id = `${rule.id}:split:${randomUUID()}`;
    ids.add(rule.id);
  }
  return restored;
}
/** Restore changed portions only. Later unrelated declarations survive; conflicting edits must be undone first. */
export function prepareCodexLedgerUndo(card: RateCard, request: CodexLedgerUndo,
  options: { now?: string } = {}): PreparedCodexLedgerChange {
  const before = codexLedgerSettings(card); validateRequest(request, before.revision);
  const entry = (card.codex_ledger_policy && history(card.codex_ledger_policy))?.edits.find(edit => edit.token === request.undo_token);
  if (!entry) throw new Error("Undo token is unknown or outside the retained declaration history");
  const proposed = structuredClone(before.policy);
  for (const key of collections) {
    const previous = entry.before[key] as Rule[], applied = entry.after[key] as Rule[];
    const touched = new Set([...previous, ...applied].map(rule => rule.id).filter(id =>
      !same(previous.find(rule => rule.id === id), applied.find(rule => rule.id === id))));
    const current = proposed[key] as Rule[];
    if ([...touched].every(id => same(current.find(rule => rule.id === id), applied.find(rule => rule.id === id)))) {
      (proposed[key] as Rule[]) = [...current.filter(rule => !touched.has(rule.id)),
        ...previous.filter(rule => touched.has(rule.id)).map(rule => structuredClone(rule))];
    } else (proposed[key] as Rule[]) = restoreTemporalCollection(previous, applied, current, touched);
    const order = new Map(previous.map((rule, index) => [rule.id, index]));
    (proposed[key] as Rule[]).sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const touchedTiers = new Set([...entry.before.tiers, ...entry.after.tiers].filter(tier =>
    entry.before.tiers.includes(tier) !== entry.after.tiers.includes(tier)));
  for (const tier of touchedTiers) {
    if (proposed.tiers.includes(tier) !== entry.after.tiers.includes(tier)) throw new Error("Undo conflicts with a later declaration");
    proposed.tiers = proposed.tiers.filter(value => value !== tier);
    if (entry.before.tiers.includes(tier)) proposed.tiers.push(tier);
  }
  for (const key of ["long_context_premium", "notes"] as const) {
    if (same(entry.before[key], entry.after[key])) continue;
    if (!same(proposed[key], entry.after[key])) throw new Error("Undo conflicts with a later declaration");
    if (entry.before[key] === undefined) delete proposed[key];
    else Object.assign(proposed, { [key]: structuredClone(entry.before[key]) });
  }
  return finish(card, before, proposed, request, options, entry.token);
}
export function saveCodexLedgerEdit(ctx: { rateCards: RateCard }, edit: CodexLedgerEdit,
  target = configWriteTarget("rate-cards.json")): PreparedCodexLedgerChange {
  return persist(ctx, target, card => prepareCodexLedgerEdit(card, edit));
}
export function saveCodexLedgerUndo(ctx: { rateCards: RateCard }, undo: CodexLedgerUndo,
  target = configWriteTarget("rate-cards.json")): PreparedCodexLedgerChange {
  return persist(ctx, target, card => prepareCodexLedgerUndo(card, undo));
}
function persist(ctx: { rateCards: RateCard }, target: string,
  prepare: (card: RateCard) => PreparedCodexLedgerChange): PreparedCodexLedgerChange {
  // Preparation and replacement are synchronous so requests in this server cannot interleave.
  const card: RateCard = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : ctx.rateCards;
  const result = prepare(card);
  if (result.changed) atomicArchiveWrite(target, JSON.stringify(result.card, null, 2) + "\n");
  ctx.rateCards = withContextRates(result.card);
  return result;
}
