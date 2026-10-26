import { withContextPreview, contextRequested } from "./codex-context-preview";
import type { AppContext } from "./app-context-types";
import { loadAccountResolver } from "./account-resolver";
import { codexLedgerReadContext, readCodexLedgerOwnedSeries } from "../db/codex-ledger-adapters";
import { readRegisterDays } from "../db/usage-price-read-account";
import { decodeCounts, decodeQuality, decodeTokens } from "../db/usage-price-measures";
import { usageLedgerReadiness, usageLedgerScope } from "../db/usage-ledger-read";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { DecimalSum } from "../shared/decimal-amount";
import { ledgerProviderOf, TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import { readOwnedLedgerHours, sumTokens } from "./ledger-sums";
import { isAccountingDay } from "./codex-accounting-pricing";
import { currentProjectRules } from "../projects/rules-now";
import type { WindowProject, WindowProjectMeasures, WindowProjectsResponse } from "../shared/window-projects";
import type { WindowActivity } from "../shared/window-activity";

const HOUR = 3_600_000;
type Context = Pick<AppContext, "sqlite" | "rateCards" | "accounts">;
export function windowProjectsRequest(url: URL) {
  const account = url.searchParams.get("account")?.trim().toLowerCase() ?? "";
  const instant = (key: string) => {
    const value = url.searchParams.get(key) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !isAccountingDay(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))
      throw new Error("Expected an ISO timestamp with a time zone");
    return new Date(value).toISOString();
  };
  const from = instant("from"), until = instant("until");
  if (!account || ["all", "__all__"].includes(account)) throw new Error("Choose one account");
  if (until <= from || Date.parse(until) - Date.parse(from) > 366 * 86_400_000) throw new Error("Expected an ordered window of at most 366 days");
  return { account, from, until };
}
export function windowProjectsProvider(ctx: Context, account: string): string | null {
  const subscription = ctx.accounts.subscriptions.find(row => row.id.toLowerCase() === account.replace(/::business$/, ""));
  if (!subscription) return null;
  const vendor = (subscription.vendor || "codex").toLowerCase();
  return ["codex", "openai"].includes(vendor) ? "codex" : ledgerProviderOf(vendor)?.id ?? null;
}
const empty = (): WindowProjectMeasures => ({ calls: 0, tokens: 0, api_usd: null, unpriced_calls: 0, invalid_calls: 0, approximate_calls: 0, unknown_mode_tokens: 0 });
const count = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Project counters exceed the supported range");
  return value;
};
const projectOf = (subject: string | null) => subject?.startsWith("p:") ? subject.slice(2) : null;

/** Published register rows and hour sums only; the shared readers own prices, copies, projects and dated accounts. */
export function readWindowProjects(ctx: Context, request: ReturnType<typeof windowProjectsRequest>, contextPreview = false): WindowProjectsResponse {
  const { account, from, until } = request, provider = windowProjectsProvider(ctx, account);
  if (!provider) throw new Error("Unknown subscription");
  return withContextPreview(ctx.sqlite, () => {
    const resolver = loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions);
    const range = { since: from.slice(0, 10), until: new Date(Date.parse(until) - 1).toISOString().slice(0, 10),
      within: { from: Date.parse(from), until: Date.parse(until) }, account };
    const stored = provider === "claude" ? ctx.sqlite.query(`SELECT activity FROM limit_windows
      WHERE provider=? AND account=? AND start_ts=? AND end_ts=? AND activity IS NOT NULL LIMIT 1`)
      .get(provider, account, from, until) as { activity: string } | null : null;
    const activity = stored ? JSON.parse(stored.activity) as WindowActivity : null;
    const ranges = activity ? activity.spans.map(span => ({ ...range, since: span.start.slice(0, 10),
      until: new Date(Date.parse(span.end) - 1).toISOString().slice(0, 10),
      within: { from: Date.parse(span.start), until: Date.parse(span.end) } })) : [range];
    if (provider !== "codex" && usageLedgerReadiness(ctx.sqlite, provider, ctx.rateCards).state !== "ready")
      throw new SubscriptionFactsPending("Project usage is awaiting background preparation", provider);
    const ledger = provider === "codex" ? codexLedgerReadContext(ctx.rateCards) : undefined;
    const names = new Map(currentProjectRules(ctx.sqlite).cfg.projects.map(project => [project.id, project.name]));
    const rows = ranges.flatMap(range => readRegisterDays(ctx.sqlite, usageLedgerScope(provider), provider, resolver, range, ledger));
    const groups = new Map<string | null, { row: WindowProject; money: DecimalSum; priced: number;
      models: Map<string | null, { row: WindowProject["models"][number]; money: DecimalSum; priced: number }>;
      hours: Map<string, { hour: string; tokens: number; calls: number }> }>();
    const groupOf = (id: string | null) => {
      let group = groups.get(id);
      if (!group) {
        group = { row: { ...empty(), project_id: id, name: id === null ? null : names.get(id) ?? id, models: [], hours: [] }, money: new DecimalSum(), priced: 0, models: new Map(), hours: new Map() };
        groups.set(id, group);
      }
      return group;
    };
    for (const row of rows) {
      const amount = decodeCounts(row.counts).api_actual;
      const calls = Number(amount?.pricedEvents ?? 0) + Number(amount?.unpricedEvents ?? 0);
      if (!calls) continue;
      const tokens = decodeTokens(row.tokens), quality = decodeQuality(row.quality);
      const measures = { calls, tokens: TOKEN_BUCKETS.reduce((sum, key) => sum + Number(tokens[key] ?? 0), 0),
        unpriced_calls: Number(amount?.unpricedEvents ?? 0), invalid_calls: Number(quality.invalid_token_events ?? 0),
        approximate_calls: Number(quality.approximate_time_events ?? 0), unknown_mode_tokens: Number(quality.unknown_speed_tokens ?? 0) };
      const group = groupOf(projectOf(row.subject));
      let model = group.models.get(row.model);
      if (!model) { model = { row: { ...empty(), model: row.model }, money: new DecimalSum(), priced: 0 }; group.models.set(row.model, model); }
      for (const target of [group, model]) {
        for (const key of ["calls", "tokens", "unpriced_calls", "invalid_calls", "approximate_calls", "unknown_mode_tokens"] as const)
          target.row[key] = count(target.row[key] + measures[key]);
        target.money.add(amount?.pricedSubtotal ?? "0");
        target.priced = count(target.priced + Number(amount?.pricedEvents ?? 0));
        target.row.api_usd = target.priced ? Number(target.money.toString()) : null;
      }
    }
    const addHour = (id: string | null, ms: number, tokens: number, calls: number) => {
      const group = groups.get(id);
      if (!group) return;
      const hour = new Date(Math.floor(ms / HOUR) * HOUR).toISOString();
      const point = group.hours.get(hour) ?? { hour, tokens: 0, calls: 0 };
      point.tokens = count(point.tokens + tokens); point.calls = count(point.calls + calls);
      group.hours.set(hour, point);
    };
    if (provider === "codex") {
      for (const { group, account: owner } of readCodexLedgerOwnedSeries(ctx.sqlite,
        { fromMs: range.within.from, toMs: range.within.until, grain: "hour", dependencyBases: [] }, resolver, ledger, [] as const)) {
        if (!group.selected || owner?.toLowerCase() !== account) continue;
        addHour(projectOf(group.stored.subject), group.stored.hour! * HOUR,
          TOKEN_BUCKETS.reduce((sum, key) => sum + Number(group.tokens[key] ?? 0n), 0), Number(group.calls));
      }
    } else {
      for (const range of ranges) for (const row of readOwnedLedgerHours(ctx.sqlite, provider, resolver.plan(provider, account),
        { since: range.since, until: range.until, fromMs: range.within.from, untilMs: range.within.until })) {
        // Non-plan calls retain their rate vendor in the shared dimension; they have no api_actual count.
        if (row.rate_vendor !== null) continue;
        addHour(row.project_id, row.hour! * HOUR, sumTokens(row).gross, row.calls);
      }
    }
    const projects = [...groups.values()].map(group => ({ ...group.row,
      models: [...group.models.values()].map(model => model.row).sort((a, b) => b.tokens - a.tokens || (a.model ?? "").localeCompare(b.model ?? "")),
      hours: [...group.hours.values()].sort((a, b) => a.hour.localeCompare(b.hour)) }));
    for (const project of projects) {
      if (project.hours.reduce((sum, point) => sum + point.tokens, 0) !== project.tokens
        || project.hours.reduce((sum, point) => sum + point.calls, 0) !== project.calls)
        throw new Error("Project timeline and published totals disagree");
    }
    return { ...request, provider, projects: projects.sort((a, b) => b.tokens - a.tokens || (a.project_id ?? "").localeCompare(b.project_id ?? "")) };
  }, contextPreview);
}
export function handleWindowProjects(ctx: Context, url: URL): Response {
  let request: ReturnType<typeof windowProjectsRequest>;
  try { request = windowProjectsRequest(url); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  if (!windowProjectsProvider(ctx, request.account)) return Response.json({ error: "Unknown subscription" }, { status: 400 });
  return Response.json(readWindowProjects(ctx, request, contextRequested(url)));
}
