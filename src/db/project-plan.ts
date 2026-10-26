import type {Database} from 'bun:sqlite';
import type {ProjectPlanSlice} from '../shared/project-plan';
export const hasProjectPlan=(db:Database)=>!!db.query("SELECT 1 FROM sqlite_master WHERE name='project_plan_days'").get();
export function markProjectPlanDirty(db:Database,provider:string,from:number,until:number|null):void {
  if(!hasProjectPlan(db)||!['claude','codex','*'].includes(provider))return;
  db.query("INSERT INTO project_plan_state(key,value) VALUES('invalidated','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
  const seq=Number((db.query("SELECT value FROM project_plan_state WHERE key='invalidated'").get() as {value:string}).value);
  // A changed request also participates in a five-hour peak that started on the prior day.
  const start=Number.isFinite(from)&&from>Date.parse('0000-01-02')?new Date(from-5*3_600_000).toISOString().slice(0,10):'0000-01-01';
  const end=until===null||!Number.isFinite(until)?null:new Date(Math.min(until+5*3_600_000,Date.parse('9999-12-31'))).toISOString().slice(0,10);
  db.query("INSERT INTO project_plan_dirty(provider,day,until_day,sequence) VALUES(?,?,?,?) ON CONFLICT(provider,day) DO UPDATE SET until_day=CASE WHEN until_day IS NULL OR excluded.until_day IS NULL THEN NULL ELSE MAX(until_day,excluded.until_day) END,sequence=excluded.sequence").run(provider,start,end,seq);
}
export function readProjectPlanSlices(db:Database,options:{subject?:string;account?:string;since?:string|null;until?:string|null}={}):ProjectPlanSlice[] {
  if(!hasProjectPlan(db))return [];
  const rows=db.query('SELECT body FROM project_plan_days WHERE (?1 IS NULL OR day>=?1) AND (?2 IS NULL OR day<=?2) ORDER BY day')
    .all(options.since?.slice(0,10)??null,options.until?.slice(0,10)??null) as {body:string}[];
  return rows.flatMap(r=>JSON.parse(r.body) as ProjectPlanSlice[]).filter(s=>(!options.subject||s.subject===options.subject)&&(!options.account||s.account===options.account));
}
