// Speeds per model on a database COPY, read-only: per-call speeds of canonical facts (p10/p50/p90, long calls with
// at least 256 output tokens) and the ratio of the stored day sums. Usage: bun scripts/acceptance/model-speed/speed-distribution.ts <copy.sqlite>
import { Database } from "../../../src/db/sqlite";
const db = new Database(process.argv[2]!, { readonly: true });
const facts = db.query(`SELECT model, q_out, resp_ms, usage_valid FROM usage_ledger_facts
  WHERE provider='claude' AND copy_state='canonical' AND accounting=1`).all() as Array<{ model: string | null; q_out: number; resp_ms: number | null; usage_valid: number }>;
const by = new Map<string, { calls: number; timed: number; long: number[] }>();
for (const f of facts) {
  const m = by.get(f.model ?? "(none)") ?? { calls: 0, timed: 0, long: [] }; by.set(f.model ?? "(none)", m);
  m.calls++;
  if (f.resp_ms && f.resp_ms > 0 && f.usage_valid) { m.timed++; if (f.q_out >= 256) m.long.push(f.q_out * 1000 / f.resp_ms); }
}
const sums = new Map((db.query(`SELECT m.model, SUM(d.calls - d.conflicts) calls, SUM(d.timed_calls) tc, SUM(d.timed_out) o, SUM(d.timed_ms) ms,
    SUM(d.timed_long_calls) lc, SUM(d.timed_long_out) lo, SUM(d.timed_long_ms) lms
  FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider='claude' GROUP BY m.model`).all() as
  Array<{ model: string | null; calls: number; tc: number; o: number; ms: number; lc: number; lo: number; lms: number }>).map(r => [r.model ?? "(none)", r]));
const q = (a: number[], p: number) => { if (!a.length) return "-"; const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]!.toFixed(1); };
console.log("| model | calls | timed | share | long | p10 | p50 | p90 | sum ratio (long) | sum ratio (all) |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
let all = 0, timed = 0;
for (const [model, m] of [...by].sort((a, b) => b[1].calls - a[1].calls)) {
  all += m.calls; timed += m.timed;
  if (m.calls < 500) continue;
  const s = sums.get(model);
  console.log(`| ${model} | ${m.calls} | ${m.timed} | ${(100 * m.timed / m.calls).toFixed(1)}% | ${m.long.length} | ${q(m.long, .1)} | ${q(m.long, .5)} | ${q(m.long, .9)} | ${s && s.lms ? (s.lo * 1000 / s.lms).toFixed(1) : "-"} | ${s && s.ms ? (s.o * 1000 / s.ms).toFixed(1) : "-"} |`);
}
console.log(JSON.stringify({ canonicalCalls: all, timed, unknownShare: (100 * (1 - timed / all)).toFixed(2) + "%" }));
// Stored sums against the facts they were summed from.
const daySums = db.query("SELECT SUM(timed_calls) c, SUM(timed_out) o, SUM(timed_ms) ms FROM usage_ledger_days WHERE provider='claude'").get();
const factSums = db.query(`SELECT SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN 1 ELSE 0 END) c, SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN q_out ELSE 0 END) o,
  SUM(CASE WHEN resp_ms>0 AND usage_valid=1 THEN resp_ms ELSE 0 END) ms FROM usage_ledger_facts WHERE provider='claude' AND copy_state='canonical' AND accounting=1`).get();
console.log(JSON.stringify({ daySums, factSums }));
db.close();
