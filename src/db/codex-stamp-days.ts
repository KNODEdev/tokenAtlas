import type { Database } from "./sqlite";
import { analysisHash } from "./analysis";

export const CODEX_STAMP_DAYS_SCHEMA = `
CREATE TABLE codex_stamp_days(day TEXT NOT NULL,model TEXT NOT NULL,basis TEXT NOT NULL,signature TEXT NOT NULL,
  bands TEXT NOT NULL,tiers TEXT NOT NULL,PRIMARY KEY(day,model,basis));
CREATE TABLE codex_stamp_dirty(day TEXT PRIMARY KEY);
`;
export const hasCodexStampDays = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE name='codex_stamp_days'").get();
export interface CodexStampDay { day: string; model: string; basis: string; signature: string; bands: string; tiers: string }

/** The other price basis may repartition rows; collapse it before hashing exact integer limbs. */
export function refreshCodexStampDays(db: Database, days: readonly string[]): void {
  if (!hasCodexStampDays(db)) return;
  if (!db.inTransaction) throw new Error("Stamp publication requires the ledger transaction");
  for (const day of new Set(days)) {
    const keep = new Set<string>();
    for (const basis of ["api_equivalent_usd", "chatgpt_credits"]) {
      const prefix = basis === "api_equivalent_usd" ? "api" : "credit";
      const rows = db.query(`SELECT a.dim_id,d.model,d.service_tier,a.${prefix}_band band,a.${prefix}_reason reason,a.${prefix}_zero zero,
        CAST(a.calls AS TEXT) calls,CAST(a.${prefix}_whole_hi AS TEXT) whole_hi,CAST(a.${prefix}_whole_lo AS TEXT) whole_lo,
        CAST(a.${prefix}_fraction_hi AS TEXT) fraction_hi,CAST(a.${prefix}_fraction_lo AS TEXT) fraction_lo
        FROM codex_price_ledger_aggregates a JOIN codex_price_ledger_dims d ON d.id=a.dim_id WHERE a.grain='day' AND a.day=?`)
        .all(day) as { dim_id: number; model: string | null; service_tier: string | null; band: number; reason: string; zero: number;
          calls: string; whole_hi: string; whole_lo: string; fraction_hi: string; fraction_lo: string }[];
      const models = new Map<string, { sums: Map<string, { calls: bigint; whole: bigint; fraction: bigint }>; bands: Set<number>; tiers: Set<string | null> }>();
      for (const row of rows) {
        const key = JSON.stringify(row.model);
        let model = models.get(key);
        if (!model) models.set(key, model = { sums: new Map(), bands: new Set(), tiers: new Set() });
        const group = JSON.stringify([row.dim_id, row.band, row.reason, row.zero]);
        const sum = model.sums.get(group) ?? { calls: 0n, whole: 0n, fraction: 0n };
        sum.calls += BigInt(row.calls);
        sum.whole += BigInt(row.whole_hi ?? "0") * 1000000000n + BigInt(row.whole_lo ?? "0");
        sum.fraction += BigInt(row.fraction_hi ?? "0") * 1000000000n + BigInt(row.fraction_lo ?? "0");
        model.sums.set(group, sum); if (row.band > 0) model.bands.add(row.band); model.tiers.add(row.service_tier);
      }
      for (const [key, model] of models) {
        keep.add(JSON.stringify([key, basis]));
        const signature = analysisHash([...model.sums].sort(([a], [b]) => a.localeCompare(b))
          .map(([group, sum]) => [group, String(sum.calls), String(sum.whole), String(sum.fraction)]));
        const bands = JSON.stringify([...model.bands].sort((a, b) => a - b));
        const tiers = JSON.stringify([...model.tiers].sort((a, b) => String(a).localeCompare(String(b))));
        db.query(`INSERT INTO codex_stamp_days VALUES(?,?,?,?,?,?) ON CONFLICT(day,model,basis) DO UPDATE SET
          signature=excluded.signature,bands=excluded.bands,tiers=excluded.tiers
          WHERE (signature,bands,tiers) IS NOT (excluded.signature,excluded.bands,excluded.tiers)`).run(day, key, basis, signature, bands, tiers);
      }
    }
    for (const row of db.query("SELECT model,basis FROM codex_stamp_days WHERE day=?").all(day) as { model: string; basis: string }[])
      if (!keep.has(JSON.stringify([row.model, row.basis]))) db.query("DELETE FROM codex_stamp_days WHERE day=? AND model=? AND basis=?").run(day, row.model, row.basis);
    db.query("DELETE FROM codex_stamp_dirty WHERE day=?").run(day);
  }
}

export function advanceCodexStampDays(db: Database, options: { budgetMs?: number; canWrite?(): boolean } = {}) {
  if (!hasCodexStampDays(db) || options.canWrite?.() === false) return { processed: 0, pending: false };
  const deadline = performance.now() + (options.budgetMs ?? 100);
  let processed = 0;
  for (;;) {
    if (options.canWrite?.() === false || processed && performance.now() >= deadline) break;
    const next = db.query("SELECT day FROM codex_stamp_dirty ORDER BY day DESC LIMIT 1").get() as { day: string } | null;
    if (!next) break;
    db.transaction(() => refreshCodexStampDays(db, [next.day])).immediate(); processed++;
  }
  return { processed, pending: !!db.query("SELECT 1 FROM codex_stamp_dirty LIMIT 1").get() };
}

export function codexStampDays(db: Database, range: { since?: string; until?: string; dependencyModels?: readonly (string | null)[]; dependencyBases?: readonly string[] }): CodexStampDay[] | null {
  if (!hasCodexStampDays(db)) return null;
  const terms: string[] = [], args: string[] = [];
  if (range.since) { terms.push("day>=?"); args.push(range.since); }
  if (range.until) { terms.push("day<=?"); args.push(range.until); }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  if (db.query(`SELECT 1 FROM codex_stamp_dirty ${where} LIMIT 1`).get(...args)) return null;
  if (range.dependencyModels) {
    terms.push(`model IN (SELECT value FROM json_each(?))`); args.push(JSON.stringify(range.dependencyModels.map(model => JSON.stringify(model))));
  }
  if (range.dependencyBases) { terms.push("basis IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(range.dependencyBases)); }
  return db.query(`SELECT * FROM codex_stamp_days ${terms.length ? `WHERE ${terms.join(" AND ")}` : ""} ORDER BY day,model,basis`)
    .all(...args) as CodexStampDay[];
}
