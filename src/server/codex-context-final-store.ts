import type {Database} from "../db/sqlite";
import {createHash} from "node:crypto";

export const FINAL_CONTEXT_VERSION="1";
const companionReaders=new WeakSet<object>();
export const isFinalContextDatabase=(db:Database)=>companionReaders.has(db);
const tables=["window_usage_dirty","window_usage_pending","window_usage","window_point_values","subscription_capacity_windows","subscription_capacity_state","subscription_capacity_dirty","project_plan_days","project_plan_state","project_plan_dirty","billing_cycles"];
const replacements=new Map(tables.map(name=>[name,"codex_context_final_"+name]));
const expressions=new RegExp("\\b("+tables.join("|")+")\\b","g");
export const finalHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value,(_key,value)=>typeof value==="bigint"?String(value):value)).digest("hex");
export function hasFinalContext(db:Database):boolean{return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_context_final_state'").get();}
export function finalState(db:Database,key:string):string|null{return (db.query("SELECT value FROM codex_context_final_state WHERE key=?").get(key) as {value:string}|null)?.value??null;}
export function setFinalState(db:Database,key:string,value:string):void{db.query("INSERT INTO codex_context_final_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(key,value);}
/** The original calculators may write only their new companion tables. Source money is inaccessible to writes. */
export function finalContextDatabase(db:Database,writable=false):Database {
  const rewrite=(sql:string)=>{
    const next=sql.replace(expressions,name=>replacements.get(name)!);
    if(/;\s*\S/.test(next)||/^\s*WITH\b[\s\S]*\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(next))throw new Error("Context calculator attempted a compound write");
    if(!/^\s*(SELECT|WITH|EXPLAIN|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(next)){
      if(!writable||!/^\s*(?:INSERT(?: OR \w+)? INTO|REPLACE INTO|UPDATE|DELETE FROM)\s+["`]?codex_context_final_\w+/i.test(next))
        throw new Error("Context calculator attempted a source write: "+sql.slice(0,80));
    }
    return next;
  };
  const proxy=new Proxy(db,{get(target,key){
    if(key==="query"||key==="prepare"||key==="run"||key==="exec")return (sql:string,...args:unknown[])=>(target[key as "query"] as Function).call(target,rewrite(sql),...args);
    const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
  }});
  companionReaders.add(proxy);return proxy;
}
