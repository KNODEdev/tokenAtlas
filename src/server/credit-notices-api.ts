import type { Database } from "bun:sqlite";
import { acknowledgeCreditNotices, hasCreditNoticeSchema, readOpenCreditNotices } from "../db/credit-notices";
import type { CreditNoticeView } from "../shared/credit-notices";

/** Subscription names as the current projection publishes them; an account without one shows its id. */
function labels(db: Database): Map<string, string> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_current'").get()) return new Map();
  return new Map((db.query("SELECT id, json_extract(data,'$.label') AS label FROM subscription_current").all() as
    Array<{ id: string; label: string | null }>).map(row => [row.id, row.label ?? row.id]));
}

export function readCreditNoticeViews(db: Database, now = Date.now()): CreditNoticeView[] {
  const names = labels(db);
  return readOpenCreditNotices(db, now).map(row => ({ id: row.id, provider: row.provider, account: row.account,
    label: names.get(row.account) ?? row.account, pool: row.pool, kind: row.kind, unit: row.unit, amount: row.amount,
    amount_text: row.amount_text, expires_at: row.expires_at, observed_at: row.observed_at, detail: row.detail }));
}

/**
 * `/api/credit-notices`: GET lists the open notices (stored rows, no preparation); POST `{ ids }` marks them
 * read, one short write of the user's own action.
 */
export async function handleCreditNotices(db: Database, req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ notices: hasCreditNoticeSchema(db) ? readCreditNoticeViews(db) : [] });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  let ids: unknown;
  try { ids = ((await req.json()) as { ids?: unknown }).ids; } catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
  if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id)))
    return Response.json({ error: "`ids` must be a list of notice ids" }, { status: 400 });
  if (!hasCreditNoticeSchema(db)) return Response.json({ acknowledged: 0 });
  return Response.json({ acknowledged: acknowledgeCreditNotices(db, ids as number[], new Date().toISOString()) });
}
