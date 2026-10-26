// Whole-archive measurement of the Claude parser's response-time fact (read-only on the archive).
// Entry point: ParsePool("claude") — the native parser the importer uses. Usage: bun scripts/acceptance/model-speed/parse-archive-timing.ts [binary]
import fs from "node:fs"; import path from "node:path";
import { ParsePool, parseWorkerCount } from "../../../src/ingest/parse-pool";
import { archive, archiveProfiles } from "../../../src/config/paths";
const binary = process.argv[2];
const files: Array<{ store: string; file: string }> = [];
const walk = (store: string, dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  const p = path.join(dir, e.name); if (e.isDirectory()) walk(store, p); else if (e.name.endsWith(".jsonl")) files.push({ store, file: p }); } };
for (const profile of archiveProfiles("claude")) walk(profile.endsWith("-desktop") ? "desktop" : "live", archive("claude", profile));
const bytes = files.reduce((s, f) => s + fs.statSync(f.file).size, 0);
const pool = new ParsePool(parseWorkerCount(), binary ? { binary } : {});
const started = performance.now();
type Ev = { call_id: string; model: string | null; out_total: number; resp_ms?: number | null; store: string };
const calls = new Map<string, Ev>();
let parsed = 0;
await Promise.all(Array.from({ length: pool.size * 2 }, async (_, w) => {
  for (let i = w; i < files.length; i += pool.size * 2) {
    const r = await pool.run("claude", { store: files[i]!.store, file: files[i]!.file }) as { events: Ev[] };
    // One row per (store, call_id): the copy with the larger output wins, as the importer keeps it.
    for (const e of r.events) { const k = e.store + "\u0000" + e.call_id, old = calls.get(k); if (!old || e.out_total > old.out_total) calls.set(k, e); }
    parsed++;
  }
}));
const ms = performance.now() - started;
await pool.close();
console.log(JSON.stringify({ entry: "ParsePool('claude')", binary: binary ?? "worktree", workers: pool.size, files: files.length, bytes, parseMs: Math.round(ms) }));
if (binary) process.exit(0);
const by = new Map<string, { calls: number; timed: number; speeds: number[]; longSpeeds: number[]; out: number; timedOut: number; timedMs: number; longOut: number; longMs: number }>();
let all = 0, timed = 0;
for (const e of calls.values()) {
  const m = e.model ?? "(none)"; const s = by.get(m) ?? { calls: 0, timed: 0, speeds: [], longSpeeds: [], out: 0, timedOut: 0, timedMs: 0, longOut: 0, longMs: 0 }; by.set(m, s);
  s.calls++; all++;
  if (e.resp_ms != null && e.resp_ms > 0) { s.timed++; timed++; const v = e.out_total * 1000 / e.resp_ms; s.speeds.push(v); s.timedOut += e.out_total; s.timedMs += e.resp_ms;
    if (e.out_total >= 256) { s.longSpeeds.push(v); s.longOut += e.out_total; s.longMs += e.resp_ms; } }
}
const q = (a: number[], p: number) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.floor(p * (b.length - 1))]! * 10) / 10; };
console.log(JSON.stringify({ calls: all, timed, unknownShare: Math.round((1 - timed / all) * 1000) / 10 }));
for (const [m, s] of [...by].sort((a, b) => b[1].calls - a[1].calls)) if (s.calls >= 200)
  console.log([m, s.calls, s.timed, (100 * s.timed / s.calls).toFixed(1) + "%", "long", s.longSpeeds.length, "p10/50/90", q(s.longSpeeds, .1), q(s.longSpeeds, .5), q(s.longSpeeds, .9),
    "ratio", s.longMs ? (s.longOut * 1000 / s.longMs).toFixed(1) : null, "all p50", q(s.speeds, .5), "ratio all", s.timedMs ? (s.timedOut * 1000 / s.timedMs).toFixed(1) : null].join("\t"));
