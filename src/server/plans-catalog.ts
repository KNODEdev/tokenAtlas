import fs from "fs";
import path from "path";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { REPO_ROOT, configFile, configWriteTarget } from "../config/paths";
import {
  TOKEN_TYPES, resolvePlanVersion, type TokenType, type TokenVector, type DefaultReferencePresent, type DefaultReferenceAbsent,
  type DefaultReference, type PlanLimits, type PlanVersion, type CatalogPlan, type ProviderGroup, type PlansCatalog,
} from "../shared/plan-catalog";
export * from "../shared/plan-catalog";
const FILE = "plans-catalog.json";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export type DefaultReferenceResult =
  | { kind: "present"; reference: DefaultReferencePresent; version_from: string | null; version_id: string }
  | { kind: "absent"; reason: string; version_from: string | null; version_id: string | null };
export type LocalCatalogWrite =
  | { ok: true; catalog: PlansCatalog }
  | { ok: false; error: string };
export function emptyPlansCatalog(): PlansCatalog {
  return { provider_groups: [] };
}
export function catalogPath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configFile(FILE);
}
export function catalogWritePath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configWriteTarget(FILE);
}
export function publishedCatalogPath(): string {
  return path.join(REPO_ROOT, FILE);
}
function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const ms = dayMs(value);
  return Number.isFinite(ms) && toDay(ms) === value;
}
export class CatalogValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "CatalogValidationError";
    this.errors = errors;
  }
}
function cloneCatalog(catalog: PlansCatalog): PlansCatalog {
  return JSON.parse(JSON.stringify(catalog)) as PlansCatalog;
}
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
function parseLimits(value: unknown): PlanLimits | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: PlanLimits = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
function parseTokenVector(value: unknown): TokenVector | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const out = {} as TokenVector;
  for (const key of TOKEN_TYPES) {
    const n = rec[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  return out;
}
function parseReference(value: unknown): DefaultReference | null | { invalid: string } {
  if (value == null) return null;
  const rec = asRecord(value);
  if (!rec) return { invalid: "default_reference musi być obiektem" };
  if (rec.absent === true) {
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    if (!reason) return { invalid: "absent default_reference potrzebuje `reason`" };
    if (rec.tokens_per_1pct != null) return { invalid: "absent default_reference nie może nieść wektora" };
    return { absent: true, reason };
  }
  const tokens = parseTokenVector(rec.tokens_per_1pct);
  if (!tokens) return { invalid: "default_reference.tokens_per_1pct musi mieć pięć nieujemnych typów tokenów" };
  const source = typeof rec.source === "string" ? rec.source.trim() : "";
  if (!source) return { invalid: "default_reference potrzebuje `source`" };
  const notes = typeof rec.notes === "string" ? rec.notes : rec.notes == null ? undefined : null;
  const present: DefaultReferencePresent = { tokens_per_1pct: tokens, source };
  if (notes) present.notes = notes;
  return present;
}
function parseVersion(value: unknown): PlanVersion | { invalid: string } {
  const rec = asRecord(value);
  if (!rec) return { invalid: "wersja musi być obiektem" };
  const from = rec.from == null || rec.from === "" ? null : rec.from;
  if (from != null && !isDay(from)) return { invalid: `'from' musi być datą YYYY-MM-DD albo null` };
  if (rec.usd_per_month != null && !(typeof rec.usd_per_month === "number" && Number.isFinite(rec.usd_per_month))) {
    return { invalid: `'usd_per_month' musi być liczbą albo null` };
  }
  const ref = parseReference(rec.default_reference);
  if (ref && "invalid" in ref) return ref;
  const version: PlanVersion = {
    from,
    usd_per_month: rec.usd_per_month == null ? null : rec.usd_per_month,
  };
  if (rec.usd_per_month_annual != null && typeof rec.usd_per_month_annual === "number") {
    version.usd_per_month_annual = rec.usd_per_month_annual;
  }
  const limits = parseLimits(rec.limits);
  if (limits) version.limits = limits;
  if (typeof rec.source === "string") version.source = rec.source;
  if (typeof rec.note === "string") version.note = rec.note;
  if (ref) version.default_reference = ref;
  return version;
}
function parsePlan(value: unknown): CatalogPlan | { invalid: string } {
  const rec = asRecord(value);
  if (!rec) return { invalid: "plan musi być obiektem" };
  const plan_id = typeof rec.plan_id === "string" ? rec.plan_id.trim() : "";
  const label = typeof rec.label === "string" ? rec.label.trim() : "";
  if (!plan_id) return { invalid: "plan potrzebuje `plan_id`" };
  if (!label) return { invalid: `${plan_id}: plan potrzebuje \`label\`` };
  const versionsRaw = Array.isArray(rec.versions) ? rec.versions : [];
  const versions: PlanVersion[] = [];
  for (const v of versionsRaw) {
    const parsed = parseVersion(v);
    if ("invalid" in parsed) return { invalid: `${label} (${plan_id}): ${parsed.invalid}` };
    versions.push(parsed);
  }
  const plan: CatalogPlan = { plan_id, label, versions };
  const aliases = asStringArray(rec.aliases).map((a) => a.trim()).filter(Boolean);
  if (aliases.length) plan.aliases = aliases;
  return plan;
}
function parseGroup(value: unknown): ProviderGroup | { invalid: string } {
  const rec = asRecord(value);
  if (!rec) return { invalid: "grupa dostawcy musi być obiektem" };
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const label = typeof rec.label === "string" ? rec.label.trim() : "";
  if (!id) return { invalid: "grupa dostawcy potrzebuje `id`" };
  if (!label) return { invalid: `${id}: grupa potrzebuje \`label\`` };
  const aliases = asStringArray(rec.aliases).map((a) => a.trim()).filter(Boolean);
  const plans: CatalogPlan[] = [];
  for (const p of Array.isArray(rec.plans) ? rec.plans : []) {
    const parsed = parsePlan(p);
    if ("invalid" in parsed) return parsed;
    plans.push(parsed);
  }
  return { id, label, aliases, plans };
}
export function parsePlansCatalog(raw: unknown): PlansCatalog {
  return parsePlansCatalogWithErrors(raw).catalog;
}
export function parsePlansCatalogWithErrors(raw: unknown): { catalog: PlansCatalog; errors: string[] } {
  const rec = asRecord(raw);
  if (!rec) return { catalog: emptyPlansCatalog(), errors: ["katalog musi być obiektem"] };
  const errors: string[] = [];
  if (rec.provider_groups != null && !Array.isArray(rec.provider_groups)) {
    errors.push("provider_groups musi być tablicą");
  }
  const groups: ProviderGroup[] = [];
  for (const g of Array.isArray(rec.provider_groups) ? rec.provider_groups : []) {
    const parsed = parseGroup(g);
    if ("invalid" in parsed) errors.push(parsed.invalid);
    else groups.push(parsed);
  }
  const catalog: PlansCatalog = { provider_groups: groups };
  if (Array.isArray(rec._comment) && rec._comment.every((c) => typeof c === "string")) {
    catalog._comment = rec._comment;
  }
  return { catalog, errors };
}
function planName(plan: CatalogPlan): string {
  return `${plan.label} (${plan.plan_id})`;
}
function versionKey(groupId: string, planId: string, from: string | null): string {
  return `${groupId.toLowerCase()}\0${planId.toLowerCase()}\0${from ?? ""}`;
}
function indexReferences(catalog: PlansCatalog): Map<string, DefaultReference | null | undefined> {
  const map = new Map<string, DefaultReference | null | undefined>();
  for (const group of catalog.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        map.set(versionKey(group.id, plan.plan_id, version.from), version.default_reference);
      }
    }
  }
  return map;
}
export function referencesEqual(a: DefaultReference | null | undefined, b: DefaultReference | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if ("absent" in a && a.absent) {
    return "absent" in b && b.absent === true && a.reason === b.reason;
  }
  if ("absent" in b && b.absent) return false;
  const pa = a as DefaultReferencePresent;
  const pb = b as DefaultReferencePresent;
  if (pa.source !== pb.source) return false;
  if ((pa.notes ?? null) !== (pb.notes ?? null)) return false;
  return TOKEN_TYPES.every((t) => pa.tokens_per_1pct[t] === pb.tokens_per_1pct[t]);
}
export function isAbsentReference(ref: DefaultReference | null | undefined): ref is DefaultReferenceAbsent {
  return ref != null && "absent" in ref && ref.absent === true;
}
export function validatePlansCatalog(catalog: PlansCatalog): string[] {
  const errors: string[] = [];
  const groupIds = new Set<string>();
  const aliasToGroup = new Map<string, string>();
  for (const group of catalog.provider_groups) {
    if (!group.id.trim()) {
      errors.push("każda grupa dostawcy potrzebuje `id`");
      continue;
    }
    const gid = group.id.toLowerCase();
    if (groupIds.has(gid)) errors.push(`${group.label} (${group.id}): zduplikowany id grupy`);
    groupIds.add(gid);
    const groupAliases = [group.id, ...(group.aliases ?? [])];
    for (const alias of groupAliases) {
      const key = alias.trim().toLowerCase();
      if (!key) continue;
      const taken = aliasToGroup.get(key);
      if (taken && taken !== gid) {
        errors.push(`alias '${alias}' należy do dwóch grup (${taken} i ${group.id})`);
      }
      aliasToGroup.set(key, gid);
    }
    const planIds = new Set<string>();
    const planAliasToId = new Map<string, string>();
    for (const plan of group.plans) {
      const named = planName(plan);
      if (!plan.plan_id.trim()) {
        errors.push(`${group.label}: plan bez plan_id`);
        continue;
      }
      const pid = plan.plan_id.toLowerCase();
      if (planIds.has(pid)) errors.push(`${named}: zduplikowany plan_id w grupie ${group.label}`);
      planIds.add(pid);
      for (const alias of [plan.plan_id, plan.label, ...(plan.aliases ?? [])]) {
        const key = alias.trim().toLowerCase();
        if (!key) continue;
        const taken = planAliasToId.get(key);
        if (taken && taken !== pid) {
          errors.push(`${named}: alias '${alias}' zderza się z ${taken} w grupie ${group.label}`);
        }
        planAliasToId.set(key, pid);
      }
      const starts = new Map<string, number>();
      plan.versions.forEach((version, i) => {
        if (version.from != null && !isDay(version.from)) {
          errors.push(`${named}: 'from' musi być datą YYYY-MM-DD`);
        }
        if (i > 0 && version.from == null) {
          errors.push(`${named}: wersja #${i + 1} nie ma 'from'`);
        }
        if (
          version.usd_per_month != null &&
          !(Number.isFinite(version.usd_per_month) && version.usd_per_month >= 0 && version.usd_per_month <= 100_000)
        ) {
          errors.push(`${named}: 'usd_per_month' musi być liczbą z 0..100000 albo null`);
        }
        const startKey = version.from ?? "";
        const prev = starts.get(startKey);
        if (prev != null) {
          errors.push(`${named}: zderzenie dat startu wersji ${version.from ?? "origin"}`);
        }
        starts.set(startKey, i);
        const ref = version.default_reference;
        if (ref && !isAbsentReference(ref)) {
          const present = ref as DefaultReferencePresent;
          for (const t of TOKEN_TYPES) {
            const n = present.tokens_per_1pct[t];
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
              errors.push(`${named}: default_reference.${t} musi być nieujemną liczbą`);
            }
          }
        }
      });
    }
  }
  return errors;
}
function readCatalogFile(file: string): PlansCatalog | null {
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const parsed = parsePlansCatalogWithErrors(raw);
  const errors = [...parsed.errors, ...validatePlansCatalog(parsed.catalog)];
  if (errors.length) throw new CatalogValidationError(errors);
  return parsed.catalog;
}
export function loadPublishedCatalog(): PlansCatalog {
  return readCatalogFile(publishedCatalogPath()) ?? emptyPlansCatalog();
}
export function overlayPublishedReferences(local: PlansCatalog, published: PlansCatalog): PlansCatalog {
  const refs = indexReferences(published);
  const next = cloneCatalog(local);
  for (const group of next.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        const key = versionKey(group.id, plan.plan_id, version.from);
        if (refs.has(key)) version.default_reference = refs.get(key);
      }
    }
  }
  return next;
}
export function stripDefaultReferences(catalog: PlansCatalog): PlansCatalog {
  const next = cloneCatalog(catalog);
  for (const group of next.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        delete version.default_reference;
      }
    }
  }
  return next;
}
export function loadPlansCatalog(rootDir?: string): PlansCatalog {
  const stored = readCatalogFile(catalogPath(rootDir)) ?? emptyPlansCatalog();
  if (rootDir) return stored;
  const published = loadPublishedCatalog();
  if (published.provider_groups.length === 0) return stored;
  return overlayPublishedReferences(stored, published);
}
export function savePlansCatalog(rootDir: string | undefined, cfg: PlansCatalog): void {
  atomicArchiveWrite(catalogWritePath(rootDir), JSON.stringify(cfg, null, 2) + "\n");
}
export function prepareLocalCatalogWrite(raw: unknown, published: PlansCatalog): LocalCatalogWrite {
  const parsed = parsePlansCatalogWithErrors(raw);
  const errors = [...parsed.errors, ...validatePlansCatalog(parsed.catalog)];
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const catalog = parsed.catalog;
  const publishedRefs = indexReferences(published);
  const incomingKeys = new Set<string>();
  for (const group of catalog.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        incomingKeys.add(versionKey(group.id, plan.plan_id, version.from));
      }
    }
  }
  for (const group of published.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        const key = versionKey(group.id, plan.plan_id, version.from);
        if (!incomingKeys.has(key)) {
          return {
            ok: false,
            error: `${planName(plan)}: wersja ${version.from ?? "origin"} nie może zniknąć zwykłym zapisem - publikacja referencji należy do wydania w repozytorium`,
          };
        }
      }
    }
  }
  for (const group of catalog.provider_groups) {
    for (const plan of group.plans) {
      for (const version of plan.versions) {
        if (version.default_reference == null) continue;
        const key = versionKey(group.id, plan.plan_id, version.from);
        const publishedRef = publishedRefs.get(key);
        if (!referencesEqual(version.default_reference, publishedRef ?? null)) {
          return {
            ok: false,
            error: `${planName(plan)}: default_reference nie zmienia się zwykłym zapisem - publikacja należy do wydania w repozytorium`,
          };
        }
      }
    }
  }
  return { ok: true, catalog };
}
export function resolveDefaultReference(
  catalog: PlansCatalog,
  providerAlias: string,
  planId: string,
  day: string
): DefaultReferenceResult {
  const resolved = resolvePlanVersion(catalog, providerAlias, planId, day);
  if (resolved.kind === "unassigned") {
    return { kind: "absent", reason: resolved.reason, version_from: null, version_id: null };
  }
  if (resolved.kind === "no_version_for_day") {
    return { kind: "absent", reason: "no_version_for_day", version_from: null, version_id: null };
  }
  const ref = resolved.version.default_reference;
  if (ref && !isAbsentReference(ref)) {
    return {
      kind: "present",
      reference: ref,
      version_from: resolved.version_from,
      version_id: resolved.version_id,
    };
  }
  const reason = isAbsentReference(ref) ? ref.reason : "not_published";
  return {
    kind: "absent",
    reason,
    version_from: resolved.version_from,
    version_id: resolved.version_id,
  };
}
