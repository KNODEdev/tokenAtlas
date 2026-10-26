import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Database } from "../db/sqlite";
import { readAccountsV2 } from "../config/accounts-document";
import { ARCHIVE_LOGICAL_ROOT, configFile, expandPath } from "../config/paths";
import { ACCOUNT_PERIODS, loadPeriods } from "../db/period-store";
import { archiveFolderOf } from "../server/event-source";
import type { ProjectMatch, ProjectsConfig } from "./remap";
import { workspaceRules } from "./workspaces";
import { inheritedProject, readParentPlaces, readParentContexts, parentContextJson, parentContextSql, parentThreadId, contextKey } from "./parents";

/**
 * Project rules applied at read time (docs/stored-activity-plan-2026-10-07.md, step 6): the project a call belongs to,
 * from the place it was made - its raw table's store, working directory, project name and repository - and, for dated
 * rules only, the day of its raw timestamp. This reproduces the remap's assignment (`projectCase` in remap.ts) exactly:
 * store-bound rules first, then file order, first match wins; a store names raw store values (Codex: an account label
 * names that account's homes); a cwd is a prefix or a glob of the normalized directory; without a directory column a
 * cwd rule matches the project name by its last segment; repository and project compare lower-cased; from/until bound
 * the raw day. SQL semantics are kept: `lower()` folds ASCII only, GLOB is case-sensitive, a NULL key matches nothing.
 */
export type ProjectTable = "claude_events" | "oc_events" | "events" | "grok_events";
export interface ProjectPlace { store: string | null; cwd: string | null; project: string | null; repo: string | null; source?: string | null; nested?: string | null }
export interface ProjectResolver {
  /** The project of a place on a raw day (`YYYY-MM-DD`), or null. */
  resolve(table: ProjectTable, place: ProjectPlace, day: string): string | null;
  /** Whether the answer for this place can depend on the day: a dated rule could match it. */
  dated(table: ProjectTable, place: ProjectPlace): boolean;
  /** A stamp of the rules and store bindings the answers follow (for caches). */
  stamp: string;
}

/** Bumped when the derivation above changes; readers pin it with their own contract. */
export const PROJECT_RESOLVER_RULE = "project-rules-at-read-v2-workspaces";

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** SQLite `lower(replace(x, '\', '/'))`: lower() folds ASCII letters only. */
const sqlLower = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());
const normColumn = (value: string) => sqlLower(value.replace(/\\/g, "/"));
const isGlob = (pattern: string) => /[*?[]/.test(pattern);
/**
 * SQLite's GLOB (`patternCompare` in sqlite3's func.c, case-sensitive, by code point): `*`, `?`, `[...]` with `^`
 * negation, a leading `]` as a member and `a-z` ranges. A class without its closing `]` never matches and a reversed
 * range matches nothing, as in SQLite; no pattern fails to compile.
 */
function sqliteGlob(pattern: string): (value: string) => boolean {
  const p = Array.from(pattern, c => c.codePointAt(0)!);
  const STAR = 42, ONE = 63, SET = 91, CLOSE = 93, CARET = 94, DASH = 45;
  const MATCH = 0, NOMATCH = 1, NOWILDCARD = 2;
  const compare = (pi: number, s: number[], si: number): number => {
    while (pi < p.length) {
      let c = p[pi++]!;
      if (c === STAR) {
        while (pi < p.length && (p[pi] === STAR || p[pi] === ONE)) {
          if (p[pi++] === ONE) { if (si >= s.length) return NOWILDCARD; si++; }
        }
        if (pi >= p.length) return MATCH;
        c = p[pi]!;
        if (c === SET) {
          // "[...]" right after "*": try the class at every remaining position.
          for (; si < s.length; si++) { const hit = compare(pi, s, si); if (hit !== NOMATCH) return hit; }
          return NOWILDCARD;
        }
        pi++;
        for (; si < s.length; si++) {
          if (s[si] !== c) continue;
          const hit = compare(pi, s, si + 1);
          if (hit !== NOMATCH) return hit;
        }
        return NOWILDCARD;
      }
      if (c === SET) {
        if (si >= s.length) return NOMATCH;
        const ch = s[si++]!;
        let seen = false, invert = false, prior = 0;
        let c2 = pi < p.length ? p[pi++]! : 0;
        if (c2 === CARET) { invert = true; c2 = pi < p.length ? p[pi++]! : 0; }
        if (c2 === CLOSE) { if (ch === CLOSE) seen = true; c2 = pi < p.length ? p[pi++]! : 0; }
        while (c2 !== 0 && c2 !== CLOSE) {
          if (c2 === DASH && pi < p.length && p[pi] !== CLOSE && prior > 0) {
            c2 = p[pi++]!;
            if (ch >= prior && ch <= c2) seen = true;
            prior = 0;
          } else {
            if (ch === c2) seen = true;
            prior = c2;
          }
          c2 = pi < p.length ? p[pi++]! : 0;
        }
        if (c2 === 0 || seen === invert) return NOMATCH;
        continue;
      }
      if (si >= s.length) return NOMATCH;
      const c2 = s[si++]!;
      if (c === c2) continue;
      if (c === ONE) continue;
      return NOMATCH;
    }
    return si >= s.length ? MATCH : NOMATCH;
  };
  return value => compare(0, Array.from(value, c => c.codePointAt(0)!), 0) === MATCH;
}

/** The tables the rules apply to and their keys (remap.ts `tableSpecs`); every one records a directory and a repository. */
export const PROJECT_TABLES: readonly ProjectTable[] = ["claude_events", "oc_events", "events", "grok_events"];

interface Compiled {
  id: string; dated: boolean;
  store?: Set<string>;
  cwd?: { glob: (value: string) => boolean } | { prefix: string };
  repo?: string; project?: string; from?: string; until?: string;
}

/**
 * The raw store values a rule's `store` names (remap.ts `resolveStore`): for Codex, the homes of the sources an account
 * label's periods name (from accounts.json), else the label itself; for the other tables the store itself.
 */
const hasPeriods = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_periods'").get();
export function projectStoreResolver(sqlite: Database, accountsPath = configFile("accounts.json")): (table: ProjectTable, store: string) => string[] {
  let sources: ReturnType<typeof readAccountsV2>["sources"] | undefined;
  let periods: ReturnType<typeof loadPeriods> | undefined;
  return (table, store) => {
    if (table !== "events") return [store];
    sources ??= fs.existsSync(accountsPath) ? readAccountsV2(accountsPath).sources : [];
    periods ??= hasPeriods(sqlite) ? loadPeriods(sqlite, ACCOUNT_PERIODS) : [];
    const keys = new Set(periods.filter(period => period.provider === "codex" && period.value.toLowerCase() === store.toLowerCase())
      .map(period => period.subject.toLowerCase()));
    const byId = sources.filter(source => source.vendor === "codex" && keys.has(archiveFolderOf(expandPath(source.home), ARCHIVE_LOGICAL_ROOT)?.key ?? ""));
    return byId.length ? byId.map(source => expandPath(source.home)) : [store];
  };
}

export function compileProjectResolver(cfg: ProjectsConfig, storesOf: (table: ProjectTable, store: string) => string[], workspaces = true): ProjectResolver {
  const ordered: Array<{ id: string; m: ProjectMatch }> = [];
  for (const project of cfg.projects) for (const m of project.matches ?? []) ordered.push({ id: project.id, m });
  // Store-bound rules win over generic rules; file order remains first-match-wins within each group (a stable sort).
  ordered.sort((a, b) => Number(!!b.m.store) - Number(!!a.m.store));
  const automatic = workspaces ? workspaceRules(cfg) : [];
  const globs = new Map<string, (value: string) => boolean>();
  const perTable = new Map<ProjectTable, Compiled[]>();
  const fallback = new Map<ProjectTable, Compiled[]>();
  const compile = (table: ProjectTable, entries: typeof ordered): Compiled[] => entries.map(({ id, m }) => {
    const rule: Compiled = { id, dated: !!(m.from || m.until) };
    if (m.store) rule.store = new Set(storesOf(table, m.store).map(normPath));
    if (m.cwd) {
      const n = normPath(m.cwd);
      if (isGlob(n)) { if (!globs.has(n)) globs.set(n, sqliteGlob(n)); rule.cwd = { glob: globs.get(n)! }; }
      else rule.cwd = { prefix: n };
    }
    if (m.repo) rule.repo = m.repo.toLowerCase();
    if (m.project) rule.project = m.project.toLowerCase();
    if (m.from) rule.from = m.from;
    if (m.until) rule.until = m.until;
    return rule;
  });
  for (const table of PROJECT_TABLES) {
    perTable.set(table, compile(table, ordered));
    fallback.set(table, compile(table, automatic));
  }
  const normalizedPlace = (place: ProjectPlace): ProjectPlace => ({ ...place,
    store: place.store === null ? null : normColumn(place.store), cwd: place.cwd === null ? null : normColumn(place.cwd),
    project: place.project === null ? null : sqlLower(place.project), repo: place.repo === null ? null : sqlLower(place.repo) });
  const matchesPlace = (rule: Compiled, place: ProjectPlace): boolean => {
    if (rule.store && (place.store === null || !rule.store.has(place.store))) return false;
    if (rule.cwd) {
      if (place.cwd === null) return false;
      const c = place.cwd;
      if ("glob" in rule.cwd) { if (!rule.cwd.glob(c)) return false; }
      // `c = n OR c GLOB n || '/*'` with a pattern free of glob characters: the directory or anything below it.
      else if ("prefix" in rule.cwd) { if (c !== rule.cwd.prefix && !c.startsWith(rule.cwd.prefix + "/")) return false; }
    }
    if (rule.repo !== undefined && (place.repo === null || place.repo !== rule.repo)) return false;
    if (rule.project !== undefined && (place.project === null || place.project !== rule.project)) return false;
    return true;
  };
  const inDay = (rule: Compiled, day: string) => (rule.from === undefined || day >= rule.from) && (rule.until === undefined || day < rule.until);
  return {
    stamp: createHash("sha256").update(JSON.stringify([PROJECT_RESOLVER_RULE, ordered, automatic, [...perTable.entries()].map(([table, rules]) => [table, [...rules, ...fallback.get(table)!].map(rule => [...rule.store ?? []])])])).digest("hex"),
    resolve(table, place, day) {
      place = normalizedPlace(place);
      for (const rule of perTable.get(table)!) if (matchesPlace(rule, place) && inDay(rule, day)) return rule.id;
      const ids = new Set(fallback.get(table)!.filter(rule => matchesPlace(rule, place) && inDay(rule, day)).map(rule => rule.id));
      return ids.size === 1 ? [...ids][0]! : null;
    },
    dated(table, place) {
      place = normalizedPlace(place);
      // The answer is day-independent unless a dated rule matching the place comes before the first undated match.
      for (const rule of perTable.get(table)!) {
        if (!matchesPlace(rule, place)) continue;
        if (rule.dated) return true;
        return false;
      }
      return fallback.get(table)!.some(rule => rule.dated && matchesPlace(rule, place));
    },
  };
}

/** A SQL text literal. */
const literal = (value: string) => `'${value.split("'").join("''")}'`;
/** The columns a reader's SQL names for a place; `cwd` null when the table records no directory, `day` the raw day. */
export interface PlaceColumns { store: string; cwd: string | null; project: string; repo: string | null; day: string; source?: string; nested?: string }

/**
 * The project of a row as one SQL expression over its place columns: the remap's CASE (`projectCase` in remap.ts before the
 * project phase was removed) with the rules inlined as literals, so it drops in wherever a stored `project_id` was read.
 */
export function projectCaseSql(cfg: ProjectsConfig, storesOf: (table: ProjectTable, store: string) => string[], table: ProjectTable,
  cols: PlaceColumns, contextJson = "{}"): string {
  const ordered: Array<{ id: string; m: ProjectMatch }> = [];
  for (const project of cfg.projects) for (const m of project.matches ?? []) ordered.push({ id: project.id, m });
  ordered.sort((a, b) => Number(!!b.m.store) - Number(!!a.m.store));
  const norm = (column: string) => `lower(replace(${column}, '\\', '/'))`;
  const clause = (m: ProjectMatch): string | null => {
    const where: string[] = [];
    if (m.store) where.push(`${norm(cols.store)} IN (${storesOf(table, m.store).map(value => literal(normPath(value))).join(",")})`);
    if (m.cwd) {
      if (!cols.cwd) {
        if (isGlob(m.cwd)) return null;
        const base = normPath(m.cwd).split("/").pop();
        if (!base) return null;
        where.push(`lower(${cols.project}) = ${literal(base)}`);
      } else {
        const n = normPath(m.cwd), c = norm(cols.cwd);
        where.push(isGlob(n) ? `${c} GLOB ${literal(n)}` : `(${c} = ${literal(n)} OR ${c} GLOB ${literal(n + "/*")})`);
      }
    }
    if (m.repo) {
      if (!cols.repo) return null;
      where.push(`lower(${cols.repo}) = ${literal(m.repo.toLowerCase())}`);
    }
    if (m.project) where.push(`lower(${cols.project}) = ${literal(m.project.toLowerCase())}`);
    if (m.from) where.push(`${cols.day} >= ${literal(m.from)}`);
    if (m.until) where.push(`${cols.day} < ${literal(m.until)}`);
    return where.join(" AND ") || "1";
  };
  const cases: string[] = [];
  for (const { id, m } of ordered) {
    const where = clause(m);
    if (where !== null) cases.push(`WHEN ${where} THEN ${literal(id)}`);
  }
  const grouped = new Map<string, string[]>();
  for (const { id, m } of workspaceRules(cfg)) {
    const where = clause(m);
    if (where !== null) { const list = grouped.get(id) ?? []; list.push(`(${where})`); grouped.set(id, list); }
  }
  // Explicit declarations win. Conflicting inferred projects remain unassigned, independent of file order.
  const values = [...grouped].map(([id, conditions]) => `(${literal(id)},(${conditions.join(" OR ")}))`);
  const workspaceFallback = values.length ? `(SELECT CASE WHEN COUNT(DISTINCT column1)=1 THEN MIN(column1) END
    FROM (VALUES ${values.join(",")}) WHERE column2)` : "NULL";
  const fallback = table === "events" && cols.source && cols.nested
    ? parentContextSql(contextJson, cols.source, cols.nested, cols.day, workspaceFallback) : workspaceFallback;
  return cases.length ? `(CASE ${cases.join(" ")} ELSE ${fallback} END)` : fallback;
}
/** A call's subject (`recordedEventSubject`): `p:` and its project, else `r:` and its repository, else NULL. */
export const subjectSql = (project: string, repo: string | null) => repo
  ? `(CASE WHEN ${project} IS NOT NULL THEN 'p:' || ${project} WHEN ${repo} IS NOT NULL AND trim(${repo}) <> '' THEN 'r:' || ${repo} END)`
  : `(CASE WHEN ${project} IS NOT NULL THEN 'p:' || ${project} END)`;
/** The subject of a project and a repository, as `subjectSql` gives it. */
export const subjectOf = (project: string | null, repo: string | null) =>
  project !== null ? `p:${project}` : repo !== null && repo.trim() !== "" ? `r:${repo}` : null;

/** The raw table whose rules a ledger provider's calls follow; Gemini records no project. */
export const PROJECT_TABLE_OF: Readonly<Record<string, ProjectTable | undefined>> = { claude: "claude_events", glm: "oc_events", grok: "grok_events", codex: "events" };

export interface ProjectRules {
  cfg: ProjectsConfig; resolver: ProjectResolver;
  /** `projectCaseSql` of a table for these rules. */
  sql(table: ProjectTable, cols: PlaceColumns): string;
  /** `resolver.resolve`, memoized per place (and per raw day only where a dated rule decides): readers ask per stored row. */
  projectOf(table: ProjectTable, place: ProjectPlace, rawDay: string): string | null;
}
const overrides = new WeakMap<object, ProjectsConfig>(), fileOverrides = new Map<string, ProjectsConfig>();
const fileOf = (db: Database) => { const name = (db as unknown as { filename?: string }).filename; return name && name !== ":memory:" ? name : null; };
/**
 * Test support: the rules a database's readers apply instead of projects.json (null restores the file); a database file
 * keeps them for every connection to it, as a reopened fixture reads the same projects.json.
 */
export function overrideProjectRules(db: Database, cfg: ProjectsConfig | null): void {
  const file = fileOf(db);
  if (cfg) { overrides.set(db, cfg); if (file) fileOverrides.set(file, cfg); }
  else { overrides.delete(db); if (file) fileOverrides.delete(file); }
}
const overrideOf = (db: Database) => overrides.get(db) ?? (fileOverrides.size ? fileOverrides.get(fileOf(db) ?? "") : undefined);
export const hasProjectRulesOverride = (db: Database) => overrideOf(db) !== undefined;
export const projectRulesOverride = (db: Database): ProjectsConfig | undefined => overrideOf(db);
/** Compiled rules per connection: another database's periods never answer for this one. */
const compiled = new WeakMap<object, { key: string; rules: ProjectRules }>();
const parentCache = new WeakMap<object, { stamp: string; places: ReturnType<typeof readParentPlaces>; contexts: ReturnType<typeof readParentContexts>;
  references: Set<string>; complete: boolean }>();
function parentRegisterStamp(db: Database): string {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger_state'").get()) return "none";
  return JSON.stringify(db.query("SELECT covered,revision FROM usage_ledger_state WHERE provider='codex'").get());
}
/**
 * The project rules readers apply now: projects.json (or a test override) with the store bindings of the account
 * periods and accounts.json, compiled once per change of any of them. Nothing here writes.
 */
export function projectRules(db: Database, load: () => ProjectsConfig): ProjectRules {
  const cfg = overrideOf(db) ?? load();
  const accounts = configFile("accounts.json");
  const accountsStamp = fs.existsSync(accounts) ? fs.statSync(accounts).mtimeMs : 0;
  // A store rule names Codex homes through the account periods; a database without them (a fixture) binds none. Their
  // content is the key: a replacement can keep the rows' count and ids.
  const periods = hasPeriods(db)
    ? (db.query(`SELECT json_group_array(json_array(source, account, from_ts, until_ts, origin)) v FROM
        (SELECT source, account, from_ts, until_ts, origin FROM account_periods WHERE provider='codex' ORDER BY id)`).get() as { v: string }).v : null;
  const parentStamp = parentRegisterStamp(db);
  const key = JSON.stringify([cfg, accountsStamp, periods, parentStamp]);
  const cached = compiled.get(db);
  if (cached?.key === key) return cached.rules;
  const stores = projectStoreResolver(db, accounts);
  const memo = new Map<string, string[]>();
  const storesOf = (table: ProjectTable, store: string) => {
    const k = `${table}\u0000${store}`;
    return memo.get(k) ?? memo.set(k, stores(table, store)).get(k)!;
  };
  const sqls = new Map<string, string>(), places = new Map<string, { dated: boolean; project: string | null }>();
  const datedPlaces = new Map<string, string | null>();
  const base = compileProjectResolver(cfg, storesOf);
  const explicit = compileProjectResolver(cfg, storesOf, false);
  const getParents = (place?: ProjectPlace) => {
    let entry = parentCache.get(db);
    if (!entry || entry.stamp !== parentStamp) {
      const contexts = readParentContexts(db);
      const references = new Set(contexts.flatMap(({ source, nested }) => {
        const parent = parentThreadId(nested); return parent ? [contextKey(source, parent)] : [];
      }));
      entry = { stamp: parentStamp, places: readParentPlaces(db, contexts), contexts, references, complete: false };
      parentCache.set(db, entry);
    }
    const parent = place && parentThreadId(place.nested);
    if (!entry.complete && parent && place?.source && !entry.references.has(contextKey(place.source, parent))) {
      // A caller may resolve a place not yet represented in the stored dimensions; preserve that general contract.
      entry.places = readParentPlaces(db); entry.complete = true;
    }
    return entry;
  };
  const resolveContext = (place: ProjectPlace, day: string): string | null => {
    const own = explicit.resolve("events", place, day);
    if (own !== null) return own;
    if (!place.source || !parentThreadId(place.nested)) return base.resolve("events", place, day);
    return inheritedProject({ ...place, source: place.source, nested: place.nested ?? null }, day, getParents(place).places,
      (candidate, rawDay) => explicit.resolve("events", candidate, rawDay),
      (candidate, rawDay) => base.resolve("events", candidate, rawDay));
  };
  const resolver: ProjectResolver = {
    // Pricing-only publications refresh the memo but do not change parent attribution.
    get stamp() { return attributionStamp ??= createHash("sha256").update(JSON.stringify([base.stamp, getContextJson()])).digest("hex"); },
    resolve: (table, place, day) => table === "events" ? resolveContext(place, day) : base.resolve(table, place, day),
    dated: (table, place) => table === "events" && !!place.nested?.includes("parent_thread_id") || base.dated(table, place) };
  let contextJson: string | undefined;
  let attributionStamp: string | undefined;
  const getContextJson = () => {
    const entry = getParents();
    return contextJson ??= parentContextJson(entry.contexts, entry.places,
      cfg.projects.flatMap(project => (project.matches ?? []).flatMap(m => [m.from, m.until].filter((day): day is string => !!day))), resolveContext);
  };
  const rules: ProjectRules = { cfg, resolver,
    sql(table, cols) {
      const k = JSON.stringify([table, cols]);
      const known = sqls.get(k); if (known !== undefined) return known;
      const sql = projectCaseSql(cfg, storesOf, table, cols, table === "events" && cols.source && cols.nested ? getContextJson() : "{}");
      sqls.set(k, sql); return sql;
    },
    projectOf(table, place, rawDay) {
      const k = `${table}\u0000${place.store}\u0000${place.cwd}\u0000${place.project}\u0000${place.repo}\u0000${place.source}\u0000${place.nested}`;
      let known = places.get(k);
      if (!known) {
        const dated = resolver.dated(table, place);
        known = { dated, project: dated ? null : resolver.resolve(table, place, rawDay) };
        places.set(k, known);
      }
      if (!known.dated) return known.project;
      const datedKey = `${k}\u0000${rawDay}`;
      if (datedPlaces.has(datedKey)) return datedPlaces.get(datedKey)!;
      const project = resolver.resolve(table, place, rawDay);
      // The compiled rule/period/register generation owns this bounded memo, including unassigned results.
      if (datedPlaces.size >= 20_000) datedPlaces.delete(datedPlaces.keys().next().value!);
      datedPlaces.set(datedKey, project);
      return project;
    } };
  compiled.set(db, { key, rules });
  return rules;
}
