import { contextRequested } from "./codex-context-preview";
import { buildProjectCost } from "./project-cost";
import type { AppContext } from "./app-context-types";
import { parseCommonDateParams } from "./api-request-params";
import { buildPlanPriceCoverage } from "./plan-price-coverage";
import { buildBillingCyclesView } from "./billing-cycles-view";
import type { Granularity, Breakdown } from "./repo-history";
import { ACTIVITY_CUTOFF_MINUTES } from "../db/usage-ledger";
import { listSubjects, HistoryAbortedError, buildRepoHistoryCancellable } from "./repo-history";
import { loadProjects, validateProjects, saveProjects } from "../projects/remap";
import { readLedgerTotals, readLedgerSums, sumTokens } from "./ledger-sums";
import type { LedgerSum } from "./ledger-sums";
import { normEraVendor, normEraKey } from "./eras";
import { accountResolverOf, normPath } from "./account-scope";
import type { ProjectMatch, ProjectsConfig, ProjectDef } from "../projects/remap";

export function handleProjectCost(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  return Response.json(
    buildProjectCost(ctx.sqlite, ctx.rateCards, ctx.homeToSubId, {
      contextPreview: contextRequested(url),
      since: dateParams.since,
      until: dateParams.until,
      plansCatalog: ctx.plansCatalog,
      eras: ctx.eras,
      declarations: ctx.accounts.subscriptions,
    })
  );
}

/** Which days of each priced subscription's traffic have no plan price (Settings → Account periods). */
export function handlePlanPriceCoverage(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  return Response.json(buildPlanPriceCoverage(ctx.sqlite, ctx.rateCards, {
    since: dateParams.since,
    until: dateParams.until,
    plansCatalog: ctx.plansCatalog,
    declarations: ctx.accounts.subscriptions,
  }));
}

/**
 * Stored billing cycles (docs/billing-cycles-design-2026-10-08.md §6): every account's, or one account's as a single
 * object when `provider` and `account` are given. One read of `billing_cycles`; never derives or waits (`stale`).
 */
export function handleBillingCycles(ctx: AppContext, url: URL): Response {
  const provider = url.searchParams.get("provider"), account = url.searchParams.get("account");
  const view = buildBillingCyclesView(ctx.sqlite, { provider, account },Date.now(),url.searchParams.get("context")==="1");
  return Response.json(provider && account ? url.searchParams.get("context")!=="1" ? view.accounts[0] : { ...view.accounts[0],
    ...((view as any).context_preview?{context_preview:(view as any).context_preview.accounts[0]}:{}),
    ...((view as any).context_preview_status?{context_preview_status:(view as any).context_preview_status}: {}) } : view);
}

export async function handleRepoHistory(ctx: AppContext, url: URL, req?: Request): Promise<Response> {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const granularity = (url.searchParams.get("granularity") || "month") as Granularity;
  if (!["day", "week", "month"].includes(granularity)) {
    return Response.json(
      { error: `Invalid 'granularity': '${granularity}'. Expected day, week or month.` },
      { status: 400 }
    );
  }
  const by = (url.searchParams.get("by") || "vendor") as Breakdown;
  if (!["none", "vendor", "model", "account"].includes(by)) {
    return Response.json(
      { error: `Invalid 'by': '${by}'. Expected none, vendor, model or account.` },
      { status: 400 }
    );
  }
  const gapRaw = url.searchParams.get("idle_gap");
  const idleGapMinutes = gapRaw ? Number(gapRaw) : 15;
  // Active time is stored per cutoff (decision D3 of docs/stored-activity-plan-2026-10-07.md): only those are answered.
  if (!(ACTIVITY_CUTOFF_MINUTES as readonly number[]).includes(idleGapMinutes)) {
    return Response.json(
      { error: `Invalid 'idle_gap': '${gapRaw}'. Expected one of ${ACTIVITY_CUTOFF_MINUTES.join(", ")} minutes.` },
      { status: 400 }
    );
  }
  const repo = url.searchParams.get("repo");
  const projectId = url.searchParams.get("project");
  if (!repo && !projectId) {
    return Response.json({
      idle_gap_minutes: idleGapMinutes,
      since: dateParams.since ?? null,
      until: dateParams.until ?? null,
      subjects: listSubjects(ctx.sqlite, idleGapMinutes, {
        since: dateParams.since,
        until: dateParams.until,
      }, {
        eras: ctx.eras,
        rateCards: ctx.rateCards,
        declarations: ctx.accounts.subscriptions,
        homeToSubId: ctx.homeToSubId,
      }),
    });
  }
  try {
    if (req?.signal.aborted) throw new HistoryAbortedError();
    const history = await buildRepoHistoryCancellable(
      ctx.sqlite,
      {
        repo,
        projectId,
        contextPreview: contextRequested(url),
        granularity,
        by,
        idleGapMinutes,
        since: dateParams.since,
        until: dateParams.until,
        rateCards: ctx.rateCards,
        plansCatalog: ctx.plansCatalog,
        homeToSubId: ctx.homeToSubId,
        eras: ctx.eras,
        declarations: ctx.accounts.subscriptions,
      },
      { signal: req?.signal },
    );
    if (req?.signal.aborted) throw new HistoryAbortedError();
    return Response.json(history);
  } catch (e) {
    if (e instanceof HistoryAbortedError) {
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    throw e;
  }
}

interface ProjectAgg {
  calls: number;
  tokens: number;
  first_ts: string | null;
  last_ts: string | null;
}

export function handleProjects(ctx: AppContext): Response {
  const cfg = loadProjects();
  const byProject = new Map<string, Record<string, ProjectAgg>>();
  for (const row of readLedgerTotals(ctx.sqlite, ["claude", "codex", "opencode"], "project_id")) {
    const key = row.key ?? "";
    const vendors = byProject.get(key) ?? {};
    const current = vendors[row.vendor] ?? { calls: 0, tokens: 0, first_ts: row.first_ts, last_ts: row.last_ts };
    current.calls += row.calls;
    current.tokens += row.tokens;
    if (!current.first_ts || row.first_ts < current.first_ts) current.first_ts = row.first_ts;
    if (!current.last_ts || row.last_ts > current.last_ts) current.last_ts = row.last_ts;
    vendors[row.vendor] = current;
    byProject.set(key, vendors);
  }
  const summarise = (id: string | null) => {
    const v = byProject.get(id ?? "") ?? {};
    let calls = 0;
    let tokens = 0;
    let first: string | null = null;
    let last: string | null = null;
    for (const a of Object.values(v)) {
      calls += a.calls;
      tokens += a.tokens;
      if (a.first_ts && (!first || a.first_ts < first)) first = a.first_ts;
      if (a.last_ts && (!last || a.last_ts > last)) last = a.last_ts;
    }
    return { calls, tokens, first_ts: first, last_ts: last, vendors: v };
  };
  return Response.json({
    projects: cfg.projects.map((p) => ({ ...p, ...summarise(p.id) })),
    unassigned: summarise(null),
    file: "projects.json",
  });
}

const SUBJECT_SEP = String.fromCharCode(0);

interface UnassignedRow {
  vendor: string;
  store: string;
  account_ids: string[];
  cwd: string | null;
  project: string | null;
  calls: number;
  tokens: number;
  first_ts: string;
  last_ts: string;
}

/** Build the small account-period index once per request; project rows themselves may span years. */
function projectRowAccountLookup(ctx: AppContext, vendors: readonly string[]): (row: LedgerSum) => string[] {
  const resolver = accountResolverOf(ctx);
  const bySource = new Map<string, Array<{ account: string; from: number; until: number }>>();
  for (const provider of new Set(vendors.map(normEraVendor))) for (const account of resolver.accounts(provider)) {
    for (const range of resolver.plan(provider, account).ranges) {
      const key = `${provider}\u0000${range.source}`, entries = bySource.get(key) ?? [];
      entries.push({ account, from: range.from, until: range.until });
      bySource.set(key, entries);
    }
  }
  return row => {
    const direct = resolver.identityAccount(row.vendor, row.identity ?? null);
    if (direct) return [direct.toLowerCase()];
    if (!row.source) return [];
    const first = Date.parse(row.first_ts), last = Date.parse(row.last_ts);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
    const ranges = bySource.get(`${normEraVendor(row.vendor)}\u0000${normEraKey(row.source)}`) ?? [];
    return [...new Set(ranges.filter(range => range.from < last + 1 && first < range.until).map(range => range.account))];
  };
}

export function handleProjectsRows(ctx: AppContext, url: URL): Response {
  let limit = parseInt(url.searchParams.get("limit") || "200", 10);
  if (isNaN(limit) || limit <= 0) limit = 200;
  const pid = url.searchParams.get("project_id") || null;
  const terms = (url.searchParams.get("q") || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  // Where calls were made (store, working directory, recorded project), from the ledgers' place dimensions.
  const sums = readLedgerSums(ctx.sqlite, { vendors: ["claude", "codex", "opencode"], grain: "day", includeIdentity: true });
  const accountIds = projectRowAccountLookup(ctx, sums.map(row => row.vendor));
  const rows: UnassignedRow[] = sums.filter(row => row.project_id === pid)
    .map(row => ({ vendor: row.vendor, store: row.home ?? "", account_ids: accountIds(row), cwd: row.cwd,
      project: row.project, calls: row.calls, tokens: sumTokens(row).gross, first_ts: row.first_ts, last_ts: row.last_ts }));
  for (const r of rows) {
    if (r.vendor === "codex") r.store = ctx.homeToSubId.get(normPath(r.store)) ?? r.store;
  }
  const merged = new Map<string, UnassignedRow>();
  for (const r of rows) {
    const key = [r.vendor, r.store, r.cwd ?? "", r.project ?? ""].join(SUBJECT_SEP);
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...r });
      continue;
    }
    cur.calls += r.calls;
    cur.tokens += r.tokens;
    cur.account_ids = [...new Set([...cur.account_ids, ...r.account_ids])].sort();
    if (r.first_ts && r.first_ts < cur.first_ts) cur.first_ts = r.first_ts;
    if (r.last_ts && r.last_ts > cur.last_ts) cur.last_ts = r.last_ts;
  }
  rows.length = 0;
  rows.push(...merged.values());
  const matched = terms.length
    ? rows.filter((r) => {
        const cwdNorm = (r.cwd ?? "").replace(/\\/g, "/");
        const hay = [cwdNorm, r.project ?? "", r.store, r.vendor].join(" ").toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
    : rows;
  matched.sort((a, b) => b.tokens - a.tokens);
  return Response.json({
    project_id: pid,
    total: matched.length,
    total_unfiltered: rows.length,
    query: terms.join(" "),
    rows: matched.slice(0, limit),
  });
}

interface AssignBody {
  match: ProjectMatch;
  project_id?: string;
  new?: { id: string; name: string };
}

function resolveTarget(
  cfg: ProjectsConfig,
  body: { project_id?: string; new?: { id: string; name: string } },
): { project: ProjectDef } | { error: string; status: number } {
  const existing = body.project_id ? cfg.projects.find((p) => p.id === body.project_id) : undefined;
  if (existing) return { project: existing };
  if (body.new) {
    const fresh = body.new;
    if (cfg.projects.some((p) => p.id === fresh.id)) {
      return { error: `project '${fresh.id}' already exists`, status: 409 };
    }
    const created: ProjectDef = { id: fresh.id, name: fresh.name, matches: [] };
    cfg.projects.push(created);
    return { project: created };
  }
  return { error: "project_id not found and no `new` given", status: 404 };
}

export async function handleProjectsAssign(ctx: AppContext, req: Request): Promise<Response> {
  let body: AssignBody;
  try {
    body = (await req.json()) as AssignBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.match || (!body.match.cwd && !body.match.project && !body.match.repo)) {
    return Response.json({ error: "match needs cwd, repo or project" }, { status: 400 });
  }
  const cfg = loadProjects();
  const resolved = resolveTarget(cfg, body);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });
  const target = resolved.project;
  const m: ProjectMatch = {};
  if (body.match.store) m.store = body.match.store;
  if (body.match.cwd) m.cwd = body.match.cwd;
  if (body.match.repo) m.repo = body.match.repo;
  if (body.match.project) m.project = body.match.project;
  if (body.match.from) m.from = body.match.from;
  if (body.match.until) m.until = body.match.until;
  target.matches.push(m);
  const errors = validateProjects(cfg);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  // Project rules apply at read time (projects/rules-now.ts): saving them is the whole change, nothing is written to the database.
  saveProjects(cfg);
  return Response.json({ ok: true, project: target, incremental: true, remap: null });
}

function sameRuleValue(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return normPath(a) === normPath(b);
}

function pointsExactlyAt(m: ProjectMatch, target: ProjectMatch): boolean {
  if (target.cwd) return m.cwd !== undefined && sameRuleValue(m.cwd, target.cwd);
  if (target.repo) return m.repo !== undefined && sameRuleValue(m.repo, target.repo);
  if (target.project) return m.project !== undefined && sameRuleValue(m.project, target.project);
  return false;
}

function cleanMatch(raw: ProjectMatch | undefined): ProjectMatch {
  const m: ProjectMatch = {};
  if (!raw || typeof raw !== "object") return m;
  const put = (key: "store" | "cwd" | "repo" | "project" | "from" | "until", value: unknown) => {
    if (typeof value === "string" && value.trim()) m[key] = value.trim();
  };
  put("store", raw.store);
  put("cwd", raw.cwd);
  put("repo", raw.repo);
  put("project", raw.project);
  put("from", raw.from);
  put("until", raw.until);
  if (m.cwd) m.cwd = m.cwd.replace(/\\/g, "/");
  return m;
}

interface ReassignBody {
  from: string;
  index?: number;
  match?: ProjectMatch;
  to?: string;
  new?: { id: string; name: string };
  drop_empty?: boolean;
}

export async function handleProjectsReassign(ctx: AppContext, req: Request): Promise<Response> {
  let body: ReassignBody;
  try {
    body = (await req.json()) as ReassignBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.from || typeof body.from !== "string") {
    return Response.json({ error: "`from` (project id) is required" }, { status: 400 });
  }
  const cfg = loadProjects();
  const source = cfg.projects.find((p) => p.id === body.from);
  if (!source) return Response.json({ error: `project '${body.from}' not found` }, { status: 404 });
  source.matches = source.matches ?? [];
  let moved: ProjectMatch[];
  if (typeof body.index === "number") {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= source.matches.length) {
      return Response.json(
        { error: `rule #${body.index} is outside '${source.id}' (${source.matches.length} rule(s))` },
        { status: 404 },
      );
    }
    moved = source.matches.splice(body.index, 1);
  } else if (body.match) {
    const wanted = cleanMatch(body.match);
    moved = source.matches.filter((m) => pointsExactlyAt(m, wanted));
    if (moved.length === 0) {
      const what = wanted.cwd ?? wanted.repo ?? wanted.project ?? "?";
      return Response.json(
        { error: `zadna regula projektu '${source.id}' nie wskazuje dokladnie ${what} - lapie go szersza regula, popraw ja w zakladce Reguly` },
        { status: 404 },
      );
    }
    source.matches = source.matches.filter((m) => !pointsExactlyAt(m, wanted));
  } else {
    return Response.json({ error: "give `index` or `match`" }, { status: 400 });
  }
  let target: ProjectDef | null = null;
  if (body.to || body.new) {
    if (body.to === source.id) {
      return Response.json({ error: "source and target are the same project" }, { status: 400 });
    }
    const resolved = resolveTarget(cfg, { project_id: body.to, new: body.new });
    if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });
    target = resolved.project;
    target.matches = target.matches ?? [];
    for (const m of moved) {
      if (!target.matches.some((t) => JSON.stringify(t) === JSON.stringify(m))) target.matches.push(m);
    }
  }
  const dropped = body.drop_empty === true && source.matches.length === 0 && source.id !== target?.id;
  if (dropped) cfg.projects = cfg.projects.filter((p) => p.id !== source.id);
  const errors = validateProjects(cfg);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  saveProjects(cfg);
  return Response.json({
    ok: true,
    moved,
    from: source.id,
    from_dropped: dropped,
    to: target?.id ?? null,
    remap: null,
  });
}

interface UpdateBody {
  project_id: string;
  new_id?: string;
  name?: string;
  note?: string | null;
  matches?: ProjectMatch[];
  delete?: boolean;
}

export async function handleProjectsUpdate(ctx: AppContext, req: Request): Promise<Response> {
  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.project_id || typeof body.project_id !== "string") {
    return Response.json({ error: "`project_id` is required" }, { status: 400 });
  }
  const cfg = loadProjects();
  const project = cfg.projects.find((p) => p.id === body.project_id);
  if (!project) return Response.json({ error: `project '${body.project_id}' not found` }, { status: 404 });
  if (body.delete === true) {
    cfg.projects = cfg.projects.filter((p) => p.id !== project.id);
    saveProjects(cfg);
    return Response.json({ ok: true, deleted: project.id, remap: null });
  }
  if (typeof body.new_id === "string" && body.new_id !== project.id) {
    if (cfg.projects.some((p) => p.id === body.new_id)) {
      return Response.json({ error: `project '${body.new_id}' already exists` }, { status: 409 });
    }
    project.id = body.new_id;
  }
  if (typeof body.name === "string") project.name = body.name.trim();
  if (body.note === null) delete project.note;
  else if (typeof body.note === "string") project.note = body.note;
  if (Array.isArray(body.matches)) project.matches = body.matches.map(cleanMatch);
  const errors = validateProjects(cfg);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  saveProjects(cfg);
  return Response.json({ ok: true, project, remap: null });
}

interface MergeBody {
  subjects: Array<{ kind: "project" | "repo"; id: string }>;
  project_id?: string;
  new?: { id: string; name: string };
}

export async function handleProjectsMerge(ctx: AppContext, req: Request): Promise<Response> {
  let body: MergeBody;
  try {
    body = (await req.json()) as MergeBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const subjects = Array.isArray(body.subjects) ? body.subjects : [];
  if (subjects.length === 0) {
    return Response.json({ error: "subjects must be a non-empty array" }, { status: 400 });
  }
  const cfg = loadProjects();
  const resolved = resolveTarget(cfg, body);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });
  const target = resolved.project;
  const absorbedRepos: string[] = [];
  const absorbedProjects: string[] = [];
  const skipped: string[] = [];
  const dropIds = new Set<string>();
  for (const s of subjects) {
    if (!s || typeof s.id !== "string" || !s.id) continue;
    if (s.kind === "project") {
      if (s.id === target.id) continue;
      const source = cfg.projects.find((p) => p.id === s.id);
      if (!source) {
        skipped.push(`project '${s.id}' not found`);
        continue;
      }
      for (const m of source.matches ?? []) {
        if (!target.matches.some((t) => JSON.stringify(t) === JSON.stringify(m))) target.matches.push(m);
      }
      dropIds.add(source.id);
      absorbedProjects.push(source.id);
    } else {
      const key = s.id.toLowerCase();
      if (target.matches.some((m) => m.repo?.toLowerCase() === key)) {
        skipped.push(`repo '${s.id}' already declared`);
        continue;
      }
      target.matches.push({ repo: s.id });
      absorbedRepos.push(s.id);
    }
  }
  if (dropIds.size) cfg.projects = cfg.projects.filter((p) => !dropIds.has(p.id));
  if (absorbedRepos.length === 0 && absorbedProjects.length === 0) {
    return Response.json({ error: `nothing to merge: ${skipped.join("; ") || "no usable subjects"}` }, { status: 400 });
  }
  const errors = validateProjects(cfg);
  if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });
  saveProjects(cfg);
  return Response.json({
    ok: true,
    project: target,
    absorbed: { repos: absorbedRepos, projects: absorbedProjects },
    skipped,
    remap: null,
  });
}
