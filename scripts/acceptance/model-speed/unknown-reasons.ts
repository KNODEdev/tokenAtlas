// Why a Claude call has no response time: the parser's rule (claude.rs request_start) replayed with a reason, whole archive.
import fs from "node:fs"; import path from "node:path";
import { archive, archiveProfiles } from "../../../src/config/paths";

const files: Array<[string, string]> = [];
const walk = (store: string, d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(store, p); else if (e.name.endsWith(".jsonl")) files.push([store, p]); } };
for (const profile of archiveProfiles("claude")) walk(profile.endsWith("-desktop") ? "desktop" : "live", archive("claude", profile));
const reasons: Record<string, number> = {}; const bump = (k: string) => reasons[k] = (reasons[k] ?? 0) + 1;
let calls = 0;
for (const [store, f] of files) {
  const heads = new Map<string, any>(); const callMap = new Map<string, { first: any; end: number | null; ok: boolean }>();
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue; let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant") { if (o.uuid && !heads.has(o.uuid)) heads.set(o.uuid, o); continue; }
    const id = o.message?.id || o.requestId || o.uuid; if (!id) continue;
    const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!(typeof o.timestamp === "string") && !(store === "desktop" && o._audit_timestamp)) { if (!callMap.has(id)) { /* dropped, no ts */ } }
    const c = callMap.get(id);
    if (!c) callMap.set(id, { first: o, end: Number.isFinite(at) ? at : null, ok: Number.isFinite(at) });
    else { c.ok = c.ok && Number.isFinite(at); if (c.end !== null && Number.isFinite(at)) c.end = Math.max(c.end, at); }
  }
  for (const [, c] of callMap) {
    calls++;
    if (!c.ok || c.end === null) { bump("block without recorded timestamp"); continue; }
    let uuid = c.first.parentUuid, reason = "", start: number | null = null;
    if (!uuid) reason = "no parentUuid";
    for (let hop = 0; !reason && hop < 64; hop++) {
      const h = heads.get(uuid);
      if (!h) { reason = hop ? "chain leaves the file" : "parent not in file (or an assistant record)"; break; }
      if (h.type === "user") { const t = typeof h.timestamp === "string" ? Date.parse(h.timestamp) : NaN; if (Number.isFinite(t)) start = t; else reason = "user record without timestamp"; break; }
      if (h.type === "system" && h.subtype === "api_error") { reason = "retried request (api_error)"; break; }
      if (h.type === "attachment" || h.type === "progress" || h.type === "system") { uuid = h.parentUuid; if (!uuid) { reason = "chain ends without a user record"; } continue; }
      reason = "chain reaches " + h.type; break;
    }
    if (!reason && start === null) reason = "chain too long";
    if (!reason && c.end! - start! <= 0) reason = "end not after start";
    bump(reason || "timed");
  }
}
console.log(JSON.stringify({ files: files.length, calls, reasons }, null, 1));
