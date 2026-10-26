import type { Database } from "bun:sqlite";
import { hasClaudeCardMetadata } from "../db/claude-card-metadata";
import { claudeLimitMetadataOfRows, type ClaudeGaugeConfig } from "./claude-limit";
import { probeReadContext, selectOwnedProbes, preparedProbeAccountIndexReady, type ProbeAccountRow } from "./current/probe-account-reader";
import { RESET_TOLERANCE_MS } from "../providers/adapters/claude";

const VERSION = 1, LIMIT = 20_000;
const COLUMNS = "p.id,p.ts,p.kind,p.scope,p.used_percent,p.resets_at";
type Member = { probe_id: number; at_ms: number; reset_ms: number | null; reset_key: string; body: string };
type Span = { from: number; until: number };
const cfgOf = (account: string): ClaudeGaugeConfig => ({ subscription: account, window_hours: 168, observations: [] });

/** One account per writer turn; only affected connected reset components are decoded and selected. */
export function advanceClaudeCardMetadata(db: Database, options: { canWrite?: () => boolean; accounts?: readonly string[] } = {}): { pending: boolean; account?: string; rows: number; components: number } {
  if (!hasClaudeCardMetadata(db)) return { pending: false, rows: 0, components: 0 };
  if (!preparedProbeAccountIndexReady(db)) return {pending:true,rows:0,components:0};
  if (options.canWrite && !options.canWrite()) return { pending: true, rows: 0, components: 0 };
  const accounts = [...new Set([...(options.accounts ?? []),...(db.query("SELECT DISTINCT account FROM limit_windows WHERE provider='claude' UNION SELECT account FROM claude_card_state")
    .all() as { account: string }[]).map(row => row.account)])];
  return db.transaction(() => {
    const global = db.query("SELECT from_ms,until_ms FROM claude_card_dirty_ranges WHERE account='*'").all() as Array<{ from_ms: number; until_ms: number | null }>;
    for (const range of global) for (const account of accounts) db.query(`INSERT INTO claude_card_dirty_ranges(account,from_ms,until_ms) VALUES(?,?,?)
      ON CONFLICT(account,from_ms) DO UPDATE SET after_id=0,until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END`)
      .run(account,range.from_ms,range.until_ms);
    if (global.length) db.query("DELETE FROM claude_card_dirty_ranges WHERE account='*'").run();
    const account = accounts.find(account => !db.query("SELECT 1 FROM claude_card_state WHERE account=? AND version=?").get(account,VERSION)
      || db.query("SELECT 1 FROM claude_card_dirty_probes WHERE account=? LIMIT 1").get(account)
      || db.query("SELECT 1 FROM claude_card_component_work WHERE account=? LIMIT 1").get(account)
      || db.query("SELECT 1 FROM claude_card_dirty_ranges WHERE account=? LIMIT 1").get(account));
    if (!account) return { pending: false, rows: 0, components: 0 };
    let visited = 0, rebuilt = 0;
    const resetSpans: Span[] = [], invalidKeys = new Set<string>();
    const affect = (member: Pick<Member,"reset_ms"|"reset_key">) => {
      if (member.reset_ms === null) invalidKeys.add(member.reset_key);
      else resetSpans.push({ from: member.reset_ms, until: member.reset_ms });
    };
    const read = (selection: Parameters<typeof selectOwnedProbes>[4]) => {
      const rows = selectOwnedProbes(db,probeReadContext(db),"claude",account,{ ...selection,columns:COLUMNS }).map(item=>item.row);
      visited += rows.length; return rows;
    };
    const store = (row: ProbeAccountRow) => {
      const reset = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
      const member = { reset_ms: Number.isFinite(reset) ? reset : null, reset_key: JSON.stringify(row.resets_at ?? null) };
      db.query("INSERT OR REPLACE INTO claude_card_members VALUES(?,?,?,?,?,?)")
        .run(account,row.id,Date.parse(row.ts),member.reset_ms,member.reset_key,JSON.stringify(row));
      affect(member);
    };
    const remove = (rows: Member[]) => { for (const row of rows) {
      affect(row); db.query("DELETE FROM claude_card_members WHERE account=? AND probe_id=?").run(account,row.probe_id);
    } };
    const initial = !db.query("SELECT 1 FROM claude_card_state WHERE account=? AND version=?").get(account,VERSION);
    let changedMembership = false;
    if (initial) {
      if (!db.query("SELECT 1 FROM claude_card_state WHERE account=?").get(account)) {
        db.query("DELETE FROM claude_card_members WHERE account=?").run(account);
        db.query("DELETE FROM claude_card_components WHERE account=?").run(account);
        db.query("DELETE FROM claude_card_dirty_probes WHERE account=?").run(account);
        db.query("DELETE FROM claude_card_dirty_ranges WHERE account=?").run(account);
        db.query("INSERT INTO claude_card_state VALUES(?,0)").run(account);
      }
      const count=(db.query("SELECT COUNT(*) n FROM claude_card_members WHERE account=?").get(account) as {n:number}).n;
      const page=read({order:"desc",limit:Math.min(500,LIMIT-count),
        where:"NOT EXISTS(SELECT 1 FROM claude_card_members m WHERE m.account=? AND m.probe_id=p.id)",params:[account]});
      for (const row of page) store(row);
      if (count+page.length<LIMIT&&page.length===500) return {pending:true,account,rows:visited,components:0};
      for(const member of db.query("SELECT reset_ms,reset_key FROM claude_card_members WHERE account=?").all(account) as Member[])affect(member);
    } else if (db.query("SELECT 1 FROM claude_card_dirty_probes WHERE account=? LIMIT 1").get(account)
      || db.query("SELECT 1 FROM claude_card_dirty_ranges WHERE account=? LIMIT 1").get(account)) {
      changedMembership = true;
      const ids = (db.query("SELECT probe_id FROM claude_card_dirty_probes WHERE account=? LIMIT 500").all(account) as {probe_id:number}[]).map(row=>row.probe_id);
      if (ids.length) {
        remove(db.query("SELECT * FROM claude_card_members WHERE account=? AND probe_id IN (SELECT value FROM json_each(?))").all(account,JSON.stringify(ids)) as Member[]);
        for (const row of read({where:"p.id IN (SELECT value FROM json_each(?))",params:[JSON.stringify(ids)]})) store(row);
        db.query("DELETE FROM claude_card_dirty_probes WHERE account=? AND probe_id IN (SELECT value FROM json_each(?))").run(account,JSON.stringify(ids));
      }
      for (const range of ids.length ? [] : db.query("SELECT from_ms,until_ms,after_id FROM claude_card_dirty_ranges WHERE account=? ORDER BY from_ms LIMIT 1").all(account) as Array<{from_ms:number;until_ms:number|null;after_id:number}>) {
        const upper = range.until_ms ?? Number.MAX_SAFE_INTEGER;
        // A changed dated owner can add or remove membership without changing a provider row.
        const old=db.query("SELECT * FROM claude_card_members WHERE account=? AND at_ms>=? AND at_ms<? AND (at_ms>? OR probe_id>?) ORDER BY at_ms,probe_id LIMIT 500")
          .all(account,range.from_ms,upper,range.from_ms,range.after_id) as Member[];
        const fresh=read({from:range.from_ms,until:upper,order:"asc",limit:500,
          where:"(s.at>? OR p.id>?)",params:[range.from_ms,range.after_id]});
        const fronts=[...(old.length===500?[{at:old.at(-1)!.at_ms,id:old.at(-1)!.probe_id}]:[]),
          ...(fresh.length===500?[{at:Date.parse(fresh.at(-1)!.ts),id:fresh.at(-1)!.id}]:[])].sort((a,b)=>a.at-b.at||a.id-b.id);
        const frontier=fronts[0];
        const inside=(at:number,id:number)=>!frontier||at<frontier.at||at===frontier.at&&id<=frontier.id;
        remove(old.filter(row=>inside(row.at_ms,row.probe_id)));
        for (const row of fresh.filter(row=>inside(Date.parse(row.ts),row.id))) store(row);
        db.query("DELETE FROM claude_card_dirty_ranges WHERE account=? AND from_ms=?").run(account,range.from_ms);
        if(frontier)db.query(`INSERT INTO claude_card_dirty_ranges(account,from_ms,until_ms,after_id) VALUES(?,?,?,?)
          ON CONFLICT(account,from_ms) DO UPDATE SET after_id=MIN(after_id,excluded.after_id),
          until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END`)
          .run(account,frontier.at,range.until_ms,frontier.id);
      }
      remove(db.query("SELECT * FROM claude_card_members WHERE account=? ORDER BY at_ms DESC,probe_id DESC LIMIT -1 OFFSET ?").all(account,LIMIT) as Member[]);
      const count = (db.query("SELECT COUNT(*) n FROM claude_card_members WHERE account=?").get(account) as {n:number}).n;
      if (count < LIMIT) for (const row of read({ order:"desc",limit:Math.min(500,LIMIT-count),
        where:"NOT EXISTS(SELECT 1 FROM claude_card_members m WHERE m.account=? AND m.probe_id=p.id)",params:[account] })) store(row);
    }
    // Adjacent/jittered resets form one exact dependency, including non-transitive A~B~C chains.
    const ranges: Span[] = [];
    for (const span of resetSpans.sort((a,b)=>a.from-b.from)) {
      const last=ranges.at(-1);
      if (last && span.from<=last.until+RESET_TOLERANCE_MS) last.until=Math.max(last.until,span.until);
      else ranges.push({...span});
    }
    for (const span of ranges) {
      for (;;) {
        const neighbor=db.query(`SELECT MIN(from_ms) lo,MAX(until_ms) hi FROM (
          SELECT from_ms,until_ms FROM claude_card_components WHERE account=? UNION ALL
          SELECT from_ms,until_ms FROM claude_card_component_work WHERE account=?)
          WHERE from_ms IS NOT NULL AND until_ms>=? AND from_ms<=?`)
          .get(account,account,span.from-RESET_TOLERANCE_MS,span.until+RESET_TOLERANCE_MS) as {lo:number|null;hi:number|null};
        const from=Math.min(span.from,neighbor.lo??span.from),until=Math.max(span.until,neighbor.hi??span.until);
        if (from===span.from&&until===span.until) break;
        span.from=from;span.until=until;
      }
    }
    const merged: Span[]=[];
    for(const span of ranges.sort((a,b)=>a.from-b.from)) {
      const last=merged.at(-1); if(last&&span.from<=last.until+RESET_TOLERANCE_MS)last.until=Math.max(last.until,span.until);else merged.push({...span});
    }
    for (const span of merged) {
      db.query("DELETE FROM claude_card_component_work WHERE account=? AND from_ms>=? AND until_ms<=?").run(account,span.from,span.until);
      db.query("INSERT INTO claude_card_component_work VALUES(?,?,?,?)").run(account,String(span.from),span.from,span.until);
    }
    for (const key of invalidKeys) db.query("INSERT OR REPLACE INTO claude_card_component_work VALUES(?,?,NULL,NULL)").run(account,`invalid:${key}`);
    // Membership changes and their component work are durable before the next bounded turn.
    if (initial || changedMembership) {
      db.query("INSERT OR REPLACE INTO claude_card_state VALUES(?,?)").run(account,VERSION);
      return {pending:true,account,rows:visited,components:0};
    }
    const publish = (key:string,from:number|null,until:number|null,members:Member[]) => {
      const rows=members.map(member=>JSON.parse(member.body) as ProbeAccountRow).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)||a.id-b.id);
      const metadata=claudeLimitMetadataOfRows(db,cfgOf(account),rows);
      db.query("INSERT OR REPLACE INTO claude_card_components VALUES(?,?,?,?,?,?)").run(account,key,from,until,metadata.observationCount,metadata.probeSampleCount);
      rebuilt++;
    };
    const work=db.query("SELECT component,from_ms,until_ms FROM claude_card_component_work WHERE account=? ORDER BY from_ms LIMIT 1").get(account) as
      {component:string;from_ms:number|null;until_ms:number|null}|null;
    for (const span of work?.from_ms != null ? [{from:work.from_ms,until:work.until_ms!}] : []) {
      db.query("DELETE FROM claude_card_components WHERE account=? AND from_ms>=? AND until_ms<=?").run(account,span.from,span.until);
      const members=db.query("SELECT * FROM claude_card_members WHERE account=? AND reset_ms>=? AND reset_ms<=? ORDER BY reset_ms")
        .all(account,span.from,span.until) as Member[];
      let group:Member[]=[];
      const flush=()=>{if(group.length){publish(String(group[0]!.reset_ms),group[0]!.reset_ms,group.at(-1)!.reset_ms,group);group=[];}};
      for(const member of members){if(group.length&&member.reset_ms!>group.at(-1)!.reset_ms!+RESET_TOLERANCE_MS)flush();group.push(member);}flush();
    }
    for(const key of work?.from_ms === null ? [work.component.slice("invalid:".length)] : []){
      db.query("DELETE FROM claude_card_components WHERE account=? AND component=?").run(account,`invalid:${key}`);
      const members=db.query("SELECT * FROM claude_card_members WHERE account=? AND reset_ms IS NULL AND reset_key=?").all(account,key) as Member[];
      if(members.length)publish(`invalid:${key}`,null,null,members);
    }
    if(work)db.query("DELETE FROM claude_card_component_work WHERE account=? AND component=?").run(account,work.component);
    return {pending:accounts.some(id=>(!db.query("SELECT 1 FROM claude_card_state WHERE account=? AND version=?").get(id,VERSION)
      ||db.query("SELECT 1 FROM claude_card_component_work WHERE account=? LIMIT 1").get(id)
      ||db.query("SELECT 1 FROM claude_card_dirty_probes WHERE account=? LIMIT 1").get(id)||db.query("SELECT 1 FROM claude_card_dirty_ranges WHERE account=? LIMIT 1").get(id))),account,rows:visited,components:rebuilt};
  }).immediate();
}
