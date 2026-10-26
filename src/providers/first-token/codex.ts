import { codexEventOwner } from "../../server/codex-event-owner";
import type { FirstTokenAdapter, FirstTokenTurn } from "./types";

const object = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
const instant = (v: unknown): string | null => typeof v === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)
  && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export const codexFirstTokenAdapter: FirstTokenAdapter = {
  id: "codex", version: 1, files: { table: "files", owner: "home" },
  prepared: { table: "codex_file_evidence", owner: "home", column: "first_token_json" },
  async prepare(pool, file) {
    const result = await pool.run("codex", { file, size: 0, firstTokenOnly: true });
    if (result.kind === "read_error") throw new Error(result.message);
    const timing = result.parse.firstToken;
    if (timing?.version !== 1 || !Array.isArray(timing.turns))
      throw new Error("Native parser has no verified first-token output; rebuild the parser.");
    return timing.turns;
  },
  baseAccount: account => account.toLowerCase().replace(/::business$/, ""),
  owner: (resolver, source, ts, billing) => codexEventOwner(resolver.resolve("codex", source, null, ts).account, { billing_mode: billing }),
  parse(lines) {
    const contexts = new Map<string, string | null>();
    const starts = new Map<string, { ts: string; billing: string }>();
    const turns = new Map<string, FirstTokenTurn>();
    let active: string | null = null;
    for (const raw of lines) {
      const row = object(raw), p = object(row.payload), id = text(p.turn_id);
      if (row.type === "turn_context" && id) contexts.set(id, text(p.model));
      if (row.type !== "event_msg") continue;
      if (p.type === "task_started" && id) {
        active = id;
        const ts = instant(row.timestamp);
        if (ts) starts.set(id, { ts, billing: "unknown" });
      }
      if (p.type === "token_count" && active) {
        const start = starts.get(active), limits = object(p.rate_limits);
        // Match the usage import's business pool, using evidence from this turn only.
        if (start && start.billing === "unknown" && limits.plan_type)
          start.billing = limits.plan_type === "self_serve_business_usage_based" ? "business_credits" : "allowance";
      }
      if (p.type !== "task_complete" || !id) continue;
      const start = starts.get(id), model = contexts.get(id) ?? null, end = instant(row.timestamp);
      if (!start || !end || Date.parse(end) < Date.parse(start.ts)) continue;
      const ms = p.time_to_first_token_ms;
      const valid = Number.isSafeInteger(ms) && ms >= 0 && Number.isSafeInteger(p.duration_ms)
        && p.duration_ms >= ms && ms <= Date.parse(end) - Date.parse(start.ts) + 1000;
      const turn: FirstTokenTurn = { id, model, ts: start.ts, ms: valid ? ms : null, billing: start.billing,
        reason: valid ? null : ms == null ? "not_recorded" : "invalid" };
      const previous = turns.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(turn))
        turns.set(id, { ...previous, ms: null, reason: "conflicting_completion" });
      else turns.set(id, turn);
      if (active === id) active = null;
    }
    return [...turns.values()];
  },
};
