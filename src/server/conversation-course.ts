import type { AppContext } from "./app-context-types";
import { withReadSnapshot } from "../db/analysis";
import { ledgerMoneyDecimal, sqlProvider } from "../db/usage-ledger";
import { usageLedgerReadiness } from "../db/usage-ledger-read";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { apiCodexAuditReader } from "./api-codex-ledger";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { preparingDataResponse } from "./preparing-response";
import { CONVERSATION_CALL_LIMIT, type ConversationCourse, type ConversationCall } from "../shared/conversation-course";

type Context = Pick<AppContext, "sqlite" | "rateCards" | "homeToSubId">;
type Fact = { row_id: number; identity: string; session: string | null; ts: string; model: string | null;
  copy_state: string; eligible: number; usage_valid: number; precise_time: number;
  q_uncached: number; q_cache_read: number; q_write_5m: number; q_write_1h: number; q_write_unknown: number; q_out: number;
  glb_usd: number; glb_nano: number; glb_femto: number; glb_reason: string | null };
const providers = { claude: "claude", opencode: "glm", grok: "grok", gemini: "gemini" } as const;

/** An indexed, bounded detail read. No producer, pricing function, or source-file access. */
export function readConversationCourse(ctx: Context, vendor: string, eventId: number, context = false): ConversationCourse | null {
  return withReadSnapshot(ctx.sqlite, () => vendor === "codex" ? codexCourse(ctx, eventId, context) : providerCourse(ctx, vendor, eventId));
}

function codexCourse(ctx: Context, eventId: number, context: boolean): ConversationCourse | null {
  const db = ctx.sqlite;
  const anchor = db.query("SELECT id,conversation FROM codex_price_ledger_copies WHERE id=?").get(eventId) as { id: number; conversation: string | null } | null;
  if (!anchor) return null;
  type Row = { id: number; home: string; path: string; source_offset: number; ts: string; model: string | null;
    copy_state: string; admitted: number; invalid_tokens: number; uncached: number; cached: number; writes: number; output: number };
  const rows = db.query(`SELECT e.id,e.source_offset,e.ts,e.copy_state,e.admitted,e.invalid_tokens,e.uncached,e.cached,e.writes,e.output,
      c.home,c.path,d.model FROM codex_price_ledger_copies c JOIN codex_price_ledger_events e ON e.copy_id=c.id
      JOIN codex_price_ledger_dims d ON d.id=e.dim_id
      WHERE ${anchor.conversation ? "c.conversation=?" : "c.id=?"} AND e.copy_state<>'duplicate'
      ORDER BY e.instant_ms,e.source_offset,e.id LIMIT ?`).all(anchor.conversation || anchor.id, CONVERSATION_CALL_LIMIT + 1) as Row[];
  const readPrice = apiCodexAuditReader(ctx, { since: rows[0]?.ts.slice(0, 10), until: rows.at(-1)?.ts.slice(0, 10) }, context);
  const selected = rows.slice(0, CONVERSATION_CALL_LIMIT);
  const calls: ConversationCall[] = [];
  let excluded = 0;
  for (const row of selected) {
    if (row.copy_state !== "canonical" || !row.admitted) { excluded++; continue; }
    const price = readPrice(row.home, row.path, row.source_offset);
    calls.push({ key: String(row.id), ts: row.ts, model: row.model,
      tokens: row.invalid_tokens ? null : { input: row.uncached, cache_read: row.cached, cache_write: row.writes, output: row.output },
      api_usd: price.value === null ? null : ledgerPresentationNumber(price.value), price_partial: price.value === null,
      ...(price.context_price ? { context_price: price.context_price } : {}) });
  }
  return { vendor: "codex", identity: anchor.conversation ?? String(anchor.id), basis: anchor.conversation ? "conversation" : "source_file",
    unit: "call", calls, truncated: rows.length > CONVERSATION_CALL_LIMIT, excluded, approximate_order: false };
}

function providerCourse(ctx: Context, vendor: string, eventId: number): ConversationCourse | null {
  const provider = Object.hasOwn(providers, vendor) ? providers[vendor as keyof typeof providers] : null;
  if (!provider) return null;
  const db = ctx.sqlite, P = sqlProvider(provider);
  const ready = usageLedgerReadiness(db, provider, ctx.rateCards);
  if (ready.state !== "ready") throw new SubscriptionFactsPending(`Conversation facts awaiting preparation (${ready.reason})`, provider);
  const anchor = db.query(`SELECT * FROM usage_ledger_facts WHERE provider=${P} AND row_id=?`).get(eventId) as Fact | null;
  if (!anchor) return null;
  let identity = anchor.session, rows: Fact[];
  if (provider === "gemini") {
    const raw = db.query("SELECT store,conversation_id FROM gemini_events WHERE id=?").get(eventId) as { store: string; conversation_id: string } | null;
    if (!raw?.conversation_id) return null;
    identity = raw.conversation_id;
    // The source's (store, conversation, generation) index supplies ordered identities only.
    const generations = db.query("SELECT gen_idx FROM gemini_events WHERE store=? AND conversation_id=? ORDER BY gen_idx LIMIT ?")
      .all(raw.store, identity, CONVERSATION_CALL_LIMIT + 1) as { gen_idx: number }[];
    const query = db.query(`SELECT * FROM usage_ledger_facts INDEXED BY usage_ledger_facts_identity_gemini
      WHERE provider='gemini' AND identity=? AND copy_state<>'duplicate' ORDER BY source_key LIMIT 1`);
    rows = generations.map(g => query.get(JSON.stringify([identity, g.gen_idx])) as Fact | null).filter((row): row is Fact => row !== null);
  } else {
    if (!identity?.trim()) return null;
    rows = db.query(`SELECT * FROM usage_ledger_facts INDEXED BY usage_ledger_facts_session_${provider}
      WHERE provider=${P} AND session=? AND copy_state<>'duplicate' ORDER BY ts,source_key LIMIT ?`)
      .all(identity, CONVERSATION_CALL_LIMIT + 1) as Fact[];
  }
  const selected = rows.slice(0, CONVERSATION_CALL_LIMIT);
  const admitted = selected.filter(row => row.copy_state === "canonical");
  const calls = admitted.map((row): ConversationCall => ({ key: String(row.row_id), ts: row.ts, model: row.model,
    tokens: row.usage_valid ? { input: row.q_uncached, cache_read: row.q_cache_read,
      cache_write: row.q_write_5m + row.q_write_1h + row.q_write_unknown, output: row.q_out } : null,
    api_usd: row.glb_reason === null ? Number(ledgerMoneyDecimal(row.glb_usd, row.glb_nano, row.glb_femto)) : null,
    price_partial: row.glb_reason !== null }));
  return { vendor, identity: identity!, basis: "conversation", unit: vendor === "grok" ? "turn" : vendor === "gemini" ? "generation" : "call",
    calls, truncated: rows.length > CONVERSATION_CALL_LIMIT, excluded: selected.length - admitted.length,
    approximate_order: provider !== "gemini" && admitted.some(row => !row.precise_time) };
}

export function handleConversationCourse(ctx: Context, url: URL): Response {
  const vendor = url.searchParams.get("vendor") ?? "", raw = url.searchParams.get("reference_id") ?? "", eventId = Number(raw);
  if (!(vendor === "codex" || Object.hasOwn(providers, vendor)) || !/^\d+$/.test(raw) || !Number.isSafeInteger(eventId) || eventId < 1)
    return Response.json({ error: "Invalid conversation event reference" }, { status: 400 });
  try {
    const course = readConversationCourse(ctx, vendor, eventId, url.searchParams.get("context") === "1");
    return course ? Response.json(course, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: "No recorded conversation for this event" }, { status: 404 });
  } catch (error) { if (error instanceof SubscriptionFactsPending) return preparingDataResponse(); throw error; }
}
