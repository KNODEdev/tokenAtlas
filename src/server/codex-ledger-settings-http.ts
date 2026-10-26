import fs from "node:fs";
import { configWriteTarget } from "../config/paths";
import type { RateCard } from "./pricing";
import type { Database } from "../db/sqlite";
import { compileCodexLedgerPolicy } from "./codex-ledger-policy";
import { CodexLedgerRevisionConflict, codexLedgerSettings, prepareCodexLedgerEdit,
  prepareCodexLedgerUndo, saveCodexLedgerEdit, saveCodexLedgerUndo,
  type CodexLedgerEdit, type CodexLedgerUndo } from "./codex-ledger-settings";

/** The existing Settings shell can use this contract without a layout change. */
export async function handleCodexLedgerSettings(ctx: { rateCards: RateCard; sqlite?: Database }, request: Request,
  target = configWriteTarget("rate-cards.json")): Promise<Response> {
  const respond = (value: unknown, status = 200) => Response.json(value,
    { status, headers: { "Cache-Control": "no-store" } });
  if (!["GET", "POST"].includes(request.method)) return respond({ error: "Method not allowed" }, 405);
  let body: unknown;
  if (request.method === "POST") {
    try { body = await request.json(); }
    catch { return respond({ error: "Expected JSON." }, 400); }
  }
  try {
    const card: RateCard = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : ctx.rateCards;
    if (request.method === "GET") {
      const settings = codexLedgerSettings(card), unknown = new Map<string | null, bigint>();
      if (ctx.sqlite?.query("SELECT 1 FROM sqlite_master WHERE name='codex_price_ledger_aggregates'").get()) {
        const policy = compileCodexLedgerPolicy(settings.policy);
        const rows = ctx.sqlite.query(`SELECT d.service_tier,a.day,CAST(SUM(a.calls) AS TEXT) calls
          FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id
          WHERE a.grain='day' GROUP BY d.service_tier,a.day`).all() as { service_tier: string | null; day: string; calls: string }[];
        for (const row of rows) if (policy.classify(row.service_tier, row.day) === null)
          unknown.set(row.service_tier, (unknown.get(row.service_tier) ?? 0n) + BigInt(row.calls));
      }
      return respond({ ...settings, unknown_raw_tiers: [...unknown].map(([raw_value, calls]) => ({ raw_value, calls: String(calls) })) });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return respond({ error: "Invalid ledger declaration." }, 400);
    const input = body as Record<string, unknown>;
    const undo = "undo_token" in input;
    // Validate and compile before the archival replacement, including exact representability.
    let prepared;
    try {
      prepared = undo ? prepareCodexLedgerUndo(card, input as unknown as CodexLedgerUndo)
        : prepareCodexLedgerEdit(card, input as unknown as CodexLedgerEdit);
      compileCodexLedgerPolicy(prepared.settings.policy);
    } catch (error) {
      return respond({ error: error instanceof Error ? error.message : String(error) },
        error instanceof CodexLedgerRevisionConflict ? 409 : 400);
    }
    if (input.preview === true) return respond({ ...prepared.settings, changed: prepared.changed, effects: prepared.effects });
    const saved = undo ? saveCodexLedgerUndo(ctx, input as unknown as CodexLedgerUndo, target)
      : saveCodexLedgerEdit(ctx, input as unknown as CodexLedgerEdit, target);
    return respond({ ...saved.settings, changed: saved.changed, effects: saved.effects, undo_token: saved.undo_token });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : String(error) },
      error instanceof CodexLedgerRevisionConflict ? 409 : 503);
  }
}
