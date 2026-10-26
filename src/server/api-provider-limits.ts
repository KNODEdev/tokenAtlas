import { buildGrokLimit, grokGaugePath, saveGrokResetAnchor, loadGrokGauge } from "./grok-limit";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import type { AppContext } from "./app-context-types";
import type { GrokResetAnchor } from "./grok-limit";
import { claudeAccountId, buildClaudeLimitCard, buildClaudeLimit } from "./claude-limit";
import { normEraVendor } from "./eras";
import { getClaudeRate } from "./pricing";
import { distinctSubscriptions, accountResolverOf } from "./account-scope";
import { HOUR_MS } from "./api-report-values";

function evidenceStillFits(
  anchorMs: number,
  windowHours: number,
  lastRefusalTs: string | undefined,
  firstSuccessTs: string | undefined
): boolean {
  if (!lastRefusalTs || !firstSuccessTs) return false;
  const lo = Date.parse(lastRefusalTs);
  const hi = Date.parse(firstSuccessTs);
  const lenMs = windowHours * 3_600_000;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || !(lenMs > 0)) return false;
  const k = Math.floor((hi - anchorMs) / lenMs);
  for (const candidate of [anchorMs + k * lenMs, anchorMs + (k - 1) * lenMs]) {
    if (candidate > lo && candidate < hi) return true;
  }
  return false;
}

/** The gauge's current window for the anchor settings; null while its rows are being prepared. */
function storedGrokCurrent(ctx: AppContext) {
  try { return buildGrokLimit(ctx.sqlite, ctx.grokGauge)?.current ?? null; }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return null;
    throw error;
  }
}

export function handleGrokAnchor(ctx: AppContext): Response {
  const a = ctx.grokGauge?.reset_anchor ?? null;
  return Response.json({
    file: grokGaugePath(),
    window_hours: ctx.grokGauge?.window_hours ?? 168,
    anchor: a,
    limit: storedGrokCurrent(ctx),
  });
}

interface GrokAnchorSaveBody {
  ts?: string | null;
  precision?: "exact" | "day";
  last_refusal_ts?: string | null;
  first_success_ts?: string | null;
  source?: string | null;
  note?: string | null;
  clear?: boolean;
}

export async function handleGrokAnchorSave(ctx: AppContext, req: Request): Promise<Response> {
  let body: GrokAnchorSaveBody;
  try {
    body = (await req.json()) as GrokAnchorSaveBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  let anchor: GrokResetAnchor | null = null;
  if (!body.clear) {
    if (!body.ts) {
      return Response.json({ error: "potrzebne `ts` albo `clear: true`" }, { status: 400 });
    }
    const ms = Date.parse(body.ts);
    if (!Number.isFinite(ms)) {
      return Response.json({ error: `ts '${body.ts}' nie jest datą` }, { status: 400 });
    }
    const ONE_YEAR_MS = 366 * 24 * 3_600_000;
    if (Math.abs(ms - Date.now()) > ONE_YEAR_MS) {
      return Response.json(
        { error: "kotwica leży ponad rok od dziś - to wygląda na literówkę w dacie" },
        { status: 400 }
      );
    }
    const clean = (v: string | null | undefined): string | undefined => {
      const t = (v ?? "").trim();
      return t.length > 0 ? t : undefined;
    };
    const prev = ctx.grokGauge?.reset_anchor ?? null;
    const windowHours = ctx.grokGauge?.window_hours ?? 168;
    const keepEvidence = evidenceStillFits(ms, windowHours, prev?.last_refusal_ts, prev?.first_success_ts);
    const lastRefusal = clean(body.last_refusal_ts) ?? (keepEvidence ? prev?.last_refusal_ts : undefined);
    const firstSuccess = clean(body.first_success_ts) ?? (keepEvidence ? prev?.first_success_ts : undefined);
    const note = clean(body.note) ?? (keepEvidence ? prev?.note : undefined);
    anchor = {
      ts: new Date(ms).toISOString(),
      precision: body.precision === "exact" ? "exact" : "day",
      ...(lastRefusal ? { last_refusal_ts: lastRefusal } : {}),
      ...(firstSuccess ? { first_success_ts: firstSuccess } : {}),
      ...(clean(body.source) ? { source: clean(body.source)! } : {}),
      ...(note ? { note } : {}),
    };
  }
  try {
    saveGrokResetAnchor(undefined, anchor);
  } catch (e) {
    return Response.json(
      { error: `zapis ${grokGaugePath()} nie powiódł się: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
  ctx.grokGauge = loadGrokGauge();
  return handleGrokAnchor(ctx);
}

export function handleClaudeLimit(ctx: AppContext, url?: URL, card = false): Response {
  const id = url?.searchParams.get("account");
  const configuredAccount = claudeAccountId(ctx.claudeGauge.subscription);
  const selected = id === null || id === undefined ? configuredAccount : claudeAccountId(id);
  const detected = ctx.vendorDiscovery?.accounts.find(a=>normEraVendor(a.vendor) === "claude" && a.id.toLowerCase() === selected?.toLowerCase());
  const declared = selected && !detected && selected.toLowerCase() !== configuredAccount?.toLowerCase()
    ? distinctSubscriptions(ctx).find(a => normEraVendor(a.vendor) === "claude" && a.id.toLowerCase() === selected.toLowerCase()) : null;
  const periodAccount = selected && selected.toLowerCase() !== configuredAccount?.toLowerCase() && !detected && !declared
    ? accountResolverOf(ctx).accounts("claude").includes(selected.toLowerCase()) : false;
  let sessionAccount = false;
  if (selected && !detected && !declared && !periodAccount && selected.toLowerCase() !== configuredAccount?.toLowerCase()) {
    const resolver = accountResolverOf(ctx);
    const identities = ctx.sqlite.query(`SELECT DISTINCT account_key FROM claude_events
      WHERE subscription_id = ? AND account_key IS NOT NULL AND COALESCE(subscription_conflict, 0) = 0`)
      .all(selected.toLowerCase()) as Array<{ account_key: string }>;
    sessionAccount = identities.some(row => resolver.identityAccount("claude", row.account_key) === selected.toLowerCase());
  }
  if (id != null && (!selected || !detected && !declared && !periodAccount && !sessionAccount && selected.toLowerCase() !== configuredAccount?.toLowerCase()))
    return Response.json({error:"Unknown Claude account"},{status:404});
  // `from`+`until` report exactly one closed window or counter segment picked in the rail; without
  // them the report is "now".
  const from = url?.searchParams.get("from"), until = url?.searchParams.get("until");
  let bounds: { from: string; until: string } | undefined;
  if (from != null || until != null) {
    const fromMs = from ? Date.parse(from) : NaN, untilMs = until ? Date.parse(until) : NaN;
    if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs <= fromMs || untilMs - fromMs > 14 * 24 * HOUR_MS)
      return Response.json({ error: "Invalid `from`/`until` bounds" }, { status: 400 });
    bounds = { from: from!, until: until! };
  }
  const asOf = bounds ? new Date(Math.min(Date.now(), Date.parse(bounds.until))).toISOString() : undefined;
  const cfg = selected && selected.toLowerCase() !== configuredAccount?.toLowerCase()
    ? {vendor:"claude",subscription:selected,plan:"unknown",window_hours:168,session_hours:5,observations:[]} : ctx.claudeGauge;
  const report = (card ? buildClaudeLimitCard : buildClaudeLimit)(ctx.sqlite, cfg, (model, day, speed) =>
    getClaudeRate(ctx.rateCards, model, day, speed), asOf,
    { rateCards: ctx.rateCards, eras: ctx.eras, resolver: accountResolverOf(ctx), cycles: ctx.cycles }, bounds
  );
  return Response.json(report);
}
