import type { Database, SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import { toArchivePhysicalPath } from "../config/paths";

export type ReparseRange = { from?:string; until?:string };
export type ReparseIdentity=Record<string,string|number>;
export type ReparseSpec={identity:string[];bookmarkTable:string|null};
type Bookmark=Record<string,SQLQueryBindings>;
export interface ReparseBounds {
  from: string | null;
  untilExclusive: string | null;
  candidateFrom: string | null;
  candidateUntil: string | null;
}
export interface ReparseSelection {
  /** Returns a semantic row predicate for the named attached database and row alias. */
  predicate(database:string,table:string,alias:string):{sql:string;params:SQLQueryBindings[]};
  /** Refuses identities whose semantic ownership cannot be proven before reconciliation. */
  assertKnown?(database:string,table:string,alias:string,identity:ReparseIdentity,bounds?:ReparseBounds):void;
}
export interface ReparsePlan {
  identities:ReparseIdentity[];
  sources:Array<ReparseIdentity & {path:string}>;
  unavailable:ReparseIdentity[];
  protectedBookmarks:Bookmark[];
  bounds?:ReparseBounds;
  selection?:ReparseSelection;
  selectedDays?:Set<string>;
  onReconciled?:(identities:ReparseIdentity[])=>void;
  partialIdentities:Set<string>;
  /** Sources whose rows prove no semantic coordinate. They keep every accepted fact
   *  they already have and are reported instead of being rewritten wholesale. */
  ambiguous?:ReparseIdentity[];
}
const key=(spec:ReparseSpec,row:Record<string,unknown>)=>JSON.stringify(spec.identity.map(field=>row[field]));
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
const sqlString=(value:string)=>`'${value.replaceAll("'","''")}'`;

function dayTime(day:string):number {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error(`Invalid reparse UTC day: ${day}`);
  const value=Date.parse(`${day}T00:00:00.000Z`);
  if(!Number.isFinite(value) || new Date(value).toISOString().slice(0,10)!==day)
    throw new Error(`Invalid reparse UTC day: ${day}`);
  return value;
}
function boundsFor(range:ReparseRange):ReparseBounds|undefined {
  if(!range.from && !range.until)return undefined;
  const from=range.from?`${range.from}T00:00:00.000Z`:null;
  const untilExclusive=range.until?new Date(dayTime(range.until)+86_400_000).toISOString():null;
  return {
    from,untilExclusive,
    candidateFrom:from?new Date(dayTime(range.from!)-86_400_000).toISOString().slice(0,10):null,
    candidateUntil:untilExclusive?new Date(Date.parse(untilExclusive)+86_400_000).toISOString().slice(0,10):null,
  };
}
/** Compare whole UTC seconds for midnight bounds without relying on fractional
 * timestamp rounding. Keep the original timestamp and its timezone unchanged. */
function utcSecondsSql(value:string):string {
  const fraction=`instr(${value},'.')`;
  return `CAST(strftime('%s',CASE WHEN ${fraction}>0
    THEN substr(${value},1,${fraction}-1)||ltrim(substr(${value},${fraction}+1),'0123456789')
    ELSE ${value} END) AS INTEGER)`;
}
function rangeSql(alias:string,bounds:ReparseBounds):{sql:string;params:string[]} {
  const seconds=utcSecondsSql(`${alias}.${quote("ts")}`);
  const clauses:string[]=[];const params:string[]=[];
  if(bounds.from){clauses.push(`${seconds}>=CAST(strftime('%s',?) AS INTEGER)`);params.push(bounds.from);}
  if(bounds.untilExclusive){clauses.push(`${seconds}<CAST(strftime('%s',?) AS INTEGER)`);params.push(bounds.untilExclusive);}
  return {sql:clauses.length?clauses.join(" AND "):"1",params};
}
function identitySql(spec:ReparseSpec,alias:string):string {
  return spec.identity.map(field=>`${alias}.${quote(field)}=?`).join(" AND ");
}
function databaseSql(database:string):string {
  return database==="main"?"main":quote(database);
}
function selectedRowsSql(plan:ReparsePlan,database:string,table:string,alias:string,
  columns:ReadonlySet<string>):{sql:string;params:SQLQueryBindings[]} {
  const clauses:string[]=[];
  const params:SQLQueryBindings[]=[];
  if(plan.bounds) {
    if(!columns.has("ts"))throw new Error(`Selected range table has no timestamp: ${table}`);
    const range=rangeSql(alias,plan.bounds);
    clauses.push(`(${range.sql})`);params.push(...range.params);
  }
  if(plan.selection) {
    const selected=plan.selection.predicate(database,table,alias);
    if(!selected.sql.trim())throw new Error(`Empty semantic selection predicate for ${table}`);
    clauses.push(`(${selected.sql})`);params.push(...selected.params);
  }
  return {sql:clauses.length?clauses.join(" AND "):"1",params};
}

/** Only the disposable stage changes. Unavailable sources keep their existing facts. */
export function prepareReparse(active:Database,stage:Database,spec:ReparseSpec,tables:string[],range:ReparseRange,
  available?: (path: string) => boolean):ReparsePlan {
  const bounds=boundsFor(range);
  const plan:ReparsePlan={identities:[],sources:[],unavailable:[],protectedBookmarks:[],bounds,
    partialIdentities:new Set()};
  const selected=new Map<string,ReparseIdentity>();
  if(bounds) for(const table of tables) {
    const columns=new Set((active.query(`PRAGMA table_info(${quote(table)})`).all() as {name:string}[]).map(row=>row.name));
    if(!columns.has("ts") || !spec.identity.every(field=>columns.has(field)))continue;
    const clauses=["ts IS NOT NULL"],params:string[]=[];
    if(bounds.candidateFrom){clauses.push("ts>=?");params.push(bounds.candidateFrom);}
    if(bounds.candidateUntil){clauses.push("ts<?");params.push(bounds.candidateUntil);}
    const exact=rangeSql("r",bounds);
    // Keep the indexed lexical candidate range, then normalize timezone/fractions in SQL.
    // Returning timestamps made DISTINCT proportional to every event rather than sources.
    const rows=active.query(`SELECT DISTINCT ${spec.identity.map(quote).join(",")}
      FROM ${quote(table)} r WHERE ${clauses.join(" AND ")} AND (${exact.sql})`)
      .all(...params,...exact.params) as ReparseIdentity[];
    for(const identity of rows)selected.set(key(spec,identity),identity);
  }
  const planned=new Set<string>(),unavailable=new Set<string>();
  const consider=(identity:ReparseIdentity,path:string,bookmark?:Bookmark)=>{
    const id=key(spec,identity);
    if(planned.has(id) || unavailable.has(id))return;
    try{
      if(available){if(!available(path))throw new Error("Source is not available to this read");}
      else fs.accessSync(toArchivePhysicalPath(path),fs.constants.R_OK);
    }catch{
      unavailable.add(id);plan.unavailable.push(identity);
      if(bookmark)plan.protectedBookmarks.push(bookmark);
      return;
    }
    planned.add(id);plan.identities.push(identity);plan.sources.push({...identity,path});
  };
  const bookmarks=spec.bookmarkTable ? (bounds
    ? stage.query(`SELECT b.* FROM json_each(?) s JOIN ${quote(spec.bookmarkTable)} b
        ON ${spec.identity.map((field,index)=>`b.${quote(field)}=json_extract(s.value,'$[${index}]')`).join(" AND ")}`)
      .all(JSON.stringify([...selected.values()].map(identity=>spec.identity.map(field=>identity[field]))))
    : stage.query(`SELECT * FROM ${quote(spec.bookmarkTable)}`).all()) as Bookmark[]
    :stage.query("SELECT key,value FROM meta WHERE key LIKE 'opencode_snapshot:%'").all() as Bookmark[];
  stage.transaction(()=> {
    for(const bookmark of bookmarks) {
      const identity=spec.bookmarkTable
        ? Object.fromEntries(spec.identity.map(field=>[field,bookmark[field]])) as ReparseIdentity
        :{store:String(bookmark.key).slice("opencode_snapshot:".length)};
      if(bounds && !selected.has(key(spec,identity)))continue;
      let source=String(bookmark.path??"");
      if(!spec.bookmarkTable) {
        const snapshot:unknown=JSON.parse(String(bookmark.value));
        if(!snapshot || typeof snapshot!=="object" || !("path" in snapshot) || typeof snapshot.path!=="string")
          throw new Error(`Invalid source bookmark: ${bookmark.key}`);
        source=snapshot.path;
      }
      consider(identity,source,bookmark);
      if(!planned.has(key(spec,identity)))continue;
      // Keep historical roots discoverable while invalidating their file fingerprints.
      if(spec.bookmarkTable)stage.query(`UPDATE ${quote(spec.bookmarkTable)} SET size=-1,mtime=-1 WHERE ${spec.identity.map(field=>`${quote(field)}=?`).join(" AND ")}`)
        .run(...spec.identity.map(field=>identity[field]!));
      else stage.query("DELETE FROM meta WHERE key=?").run(bookmark.key!);
    }
    if(bounds)for(const identity of selected.values()) {
      const id=key(spec,identity);
      // A bookmark above may already have located this source. An identity without a
      // path column - OpenCode is keyed by store alone - carries its location only there.
      if(planned.has(id) || unavailable.has(id))continue;
      const source=typeof identity.path==="string"?identity.path:"";
      if(!source){unavailable.add(id);plan.unavailable.push(identity);continue;}
      consider(identity,source);
    }
  }).immediate();
  return plan;
}

const PREFERRED_KEYS:Record<string,string[][]>={
  claude_events:[["store","call_id"]],
  claude_limit_hits:[["store","call_id"]],
  gemini_events:[["store","conversation_id","gen_idx"]],
  grok_events:[["store","source_id","session_id","prompt_id","model"]],
  oc_events:[["store","message_id"]],
};
/**
 * The Codex importer creates `events` and `ratelimit` with no PRIMARY KEY and no
 * UNIQUE index, so nothing here may be assumed: a candidate is used only for the
 * sources whose own rows show it holds. `ratelimit` writes one row per rate-limit
 * slot of a single source line, so the slot is part of the coordinate; rows indexed
 * before those columns existed have no coordinate at all.
 */
const CHECKED_KEYS:Record<string,string[][]>={
  events:[["home","path","source_offset"]],
  ratelimit:[["home","path","source_offset","source_slot"],
    ["home","path","ts","window_minutes","limit_id","source_slot"]],
};
function sameColumns(left:string[],right:string[]):boolean {
  return left.length===right.length && left.every(column=>right.includes(column));
}
function declaredSemanticKey(sqlite:Database,table:string,columns:Set<string>):string[]|null {
  const info=sqlite.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string;pk:number}>;
  const candidates:string[][]=[];
  const primary=info.filter(row=>row.pk>0).sort((a,b)=>a.pk-b.pk).map(row=>row.name);
  if(primary.length && !(primary.length===1 && primary[0]==="id"))candidates.push(primary);
  const indexes=sqlite.query(`PRAGMA index_list(${quote(table)})`).all() as Array<{name:string;unique:number;partial:number}>;
  for(const index of indexes)if(index.unique && !index.partial) {
    const fields=(sqlite.query(`PRAGMA index_info(${quote(index.name)})`).all() as Array<{seqno:number;cid:number;name:string|null}>)
      .sort((a,b)=>a.seqno-b.seqno);
    if(fields.every(field=>field.cid>=0 && field.name))candidates.push(fields.map(field=>field.name!));
  }
  const usable=candidates.filter(candidate=>candidate.length>0 && candidate.every(column=>columns.has(column))
    && !(candidate.length===1 && candidate[0]==="id"));
  for(const preferred of PREFERRED_KEYS[table]??[])if(usable.some(candidate=>sameColumns(candidate,preferred)))return preferred;
  // SQLite exposes a composite primary key again through its automatic unique index.
  const distinct=usable.filter((candidate,index)=>!usable.slice(0,index).some(prior=>sameColumns(prior,candidate)));
  const ordered=distinct.sort((a,b)=>a.length-b.length || a.join("\0").localeCompare(b.join("\0")));
  if(!ordered.length)return null;
  if(ordered.length===1 || ordered[0]!.length<ordered[1]!.length)return ordered[0]!;
  throw new Error(`No unambiguous PRIMARY/UNIQUE semantic key for ranged reparse table ${table}`);
}
/** A candidate holds for a source only when its own rows carry it and never repeat it. */
function keyAmbiguous(active:Database,alias:string,table:string,candidate:string[],spec:ReparseSpec,
  identity:ReparseIdentity):boolean {
  const where=identitySql(spec,"r");
  const params=spec.identity.map(field=>identity[field]!);
  const nullKey=candidate.map(column=>`r.${quote(column)} IS NULL`).join(" OR ");
  const keyList=candidate.map(column=>`r.${quote(column)}`).join(",");
  for(const database of ["main",quote(alias)]) {
    if(active.query(`SELECT 1 FROM ${database}.${quote(table)} r
      WHERE ${where} AND (${nullKey}) LIMIT 1`).get(...params))return true;
    if(active.query(`SELECT 1 FROM ${database}.${quote(table)} r WHERE ${where}
      GROUP BY ${keyList} HAVING COUNT(*)>1 LIMIT 1`).get(...params))return true;
  }
  return false;
}
function checkedSemanticKey(active:Database,alias:string,table:string,columns:Set<string>,spec:ReparseSpec,
  identities:ReparseIdentity[]):{semantic:string[];ambiguous:Set<string>}|null {
  let fallback:{semantic:string[];ambiguous:Set<string>}|null=null;
  for(const candidate of (CHECKED_KEYS[table]??[]).filter(entry=>entry.every(column=>columns.has(column)))) {
    const ambiguous=new Set<string>();
    for(const identity of identities)
      if(keyAmbiguous(active,alias,table,candidate,spec,identity))ambiguous.add(key(spec,identity));
    if(!ambiguous.size)return {semantic:candidate,ambiguous};
    fallback??={semantic:candidate,ambiguous};
  }
  return fallback;
}

/**
 * A bounded adapter may read a whole source file. Reconcile its stage in SQLite so
 * only semantic facts matching the selected UTC interval and/or semantic predicate
 * use staged values. A fact selected on either side remains selected after a date,
 * owner or path move; all other facts are restored byte-for-byte from the accepted
 * database. No numeric value is transported through JavaScript and constraint
 * conflicts abort publication.
 */
export function preserveReparseOutsideRange(active:Database,stage:Database,spec:ReparseSpec,tables:string[],
  initial:ReparseIdentity[],plan:ReparsePlan):ReparseIdentity[] {
  if(!plan.bounds && !plan.selection)return initial;
  const alias="reparse_range_stage";
  active.exec(`ATTACH DATABASE ${sqlString(stage.filename)} AS ${quote(alias)}`);
  const identities=new Map(initial.map(identity=>[key(spec,identity),identity]));
  const temporary:string[]=[];
  try {
    active.transaction(()=>{
      const ambiguous=new Map<string,ReparseIdentity>();
      const prepared=tables.flatMap((table,index)=>{
        const columns=tableColumns(active,table);
        if((plan.bounds && !columns.includes("ts")) || !spec.identity.every(field=>columns.includes(field)))return [];
        const declared=declaredSemanticKey(active,table,new Set(columns));
        // Without a declared key, use one the rows in play prove and refuse to guess for
        // the sources they do not: those keep the facts they already have.
        const checked=declared?null
          :checkedSemanticKey(active,alias,table,new Set(columns),spec,[...identities.values()]);
        const semantic=declared??checked?.semantic;
        if(!semantic)throw new Error(`No provable semantic key for ranged reparse table ${table}`);
        if(checked?.ambiguous.size && plan.selection) {
          const identity=[...checked.ambiguous].map(id=>identities.get(id)).find(Boolean);
          throw new Error(`Account-scoped reparse cannot prove a semantic key for ${table}${identity?`: ${JSON.stringify(identity)}`:""}`);
        }
        if(checked)for(const id of checked.ambiguous) {
          const identity=identities.get(id);
          if(identity)ambiguous.set(id,identity);
        }
        const temp=`reparse_selected_${index}`;
        temporary.push(temp);
        active.exec(`CREATE TEMP TABLE ${quote(temp)} AS SELECT ${semantic.map((column,at)=>
          `${quote(column)} AS ${quote(`k${at}`)}`).join(",") } FROM main.${quote(table)} WHERE 0`);
        // Every fact probes this set during reconciliation; a scan per fact is quadratic.
        active.exec(`CREATE INDEX temp.${quote(`${temp}_key`)} ON ${quote(temp)}
          (${semantic.map((_,at)=>quote(`k${at}`)).join(",")})`);
        return [{table,columns,semantic,temp,checked:!declared,unselectedDifferences:new Set<string>()}];
      });
      for(const id of ambiguous.keys())identities.delete(id);
      if(ambiguous.size)plan.ambiguous=[...(plan.ambiguous??[]),...ambiguous.values()];
      if(!identities.size)return;
      let expanded:boolean;
      do {
        expanded=false;
        for(const item of prepared) {
          active.exec(`DELETE FROM temp.${quote(item.temp)}`);
          for(const identity of identities.values())for(const database of ["main",alias]) {
            plan.selection?.assertKnown?.(database,item.table,"r",identity,plan.bounds);
            const selected=selectedRowsSql(plan,database,item.table,"r",new Set(item.columns));
            const where=identitySql(spec,"r");
            const nullKey=item.semantic.map(column=>`r.${quote(column)} IS NULL`).join(" OR ");
            if(active.query(`SELECT 1 FROM ${databaseSql(database)}.${quote(item.table)} r WHERE ${where} AND ${selected.sql}
              AND (${nullKey}) LIMIT 1`).get(...spec.identity.map(field=>identity[field]!),...selected.params))
              throw new Error(`Null semantic key in selected reparse table ${item.table}`);
            active.query(`INSERT INTO temp.${quote(item.temp)} SELECT ${item.semantic.map(column=>`r.${quote(column)}`).join(",")}
              FROM ${databaseSql(database)}.${quote(item.table)} r WHERE ${where} AND ${selected.sql}`)
              .run(...spec.identity.map(field=>identity[field]!),...selected.params);
          }
          const match=item.semantic.map((column,at)=>`r.${quote(column)} IS k.${quote(`k${at}`)}`).join(" AND ");
          for(const database of ["main",alias]) {
            const rows=active.query(`SELECT DISTINCT ${spec.identity.map(field=>`r.${quote(field)} AS ${quote(field)}`).join(",")}
              FROM temp.${quote(item.temp)} k CROSS JOIN ${databaseSql(database)}.${quote(item.table)} r
              WHERE ${match}`).all() as ReparseIdentity[];
            for(const row of rows) {
              const identity=Object.fromEntries(spec.identity.map(field=>[field,row[field]])) as ReparseIdentity;
              if(spec.identity.some(field=>typeof identity[field]!=="string"
                && (typeof identity[field]!=="number" || !Number.isSafeInteger(identity[field]))))
                throw new Error(`Unsafe ranged source identity in ${item.table}`);
              const id=key(spec,identity);
              if(identities.has(id))continue;
              // A fact that moved into a source proving no key cannot be bounded: keeping
              // the retained copy and publishing the staged one would count it twice.
              for(const candidate of prepared)if(candidate.checked
                  && keyAmbiguous(active,alias,candidate.table,candidate.semantic,spec,identity))
                throw new Error(`Ranged reparse cannot bound ${JSON.stringify(identity)} in ${candidate.table}`);
              identities.set(id,identity);expanded=true;
            }
          }
        }
      } while(expanded);

      // The last closure pass already populated every set with the final identities.
      // Account-scoped publication is
      // refused when it would combine changed selected facts with a different staged
      // remainder: no whole-file bookmark can truthfully witness that hybrid.
      const selectedDifferences=new Set<string>();
      const unselectedDifferences=new Set<string>();
      for(const item of prepared) {
        const keys=item.semantic.map(column=>`r.${quote(column)}`).join(",");
        for(const identity of identities.values()) {
          const identityParams=spec.identity.map(field=>identity[field]!);
          if(plan.bounds) {
            // A new undated context row remains eligible for a ranged read, but an
            // account-scoped read must prove that the context belongs to the account.
            const context=plan.selection?.predicate(alias,item.table,"r");
            const contextSql=context?` AND (${context.sql})`:"";
            active.query(`INSERT INTO temp.${quote(item.temp)} SELECT ${keys}
              FROM ${quote(alias)}.${quote(item.table)} r WHERE ${identitySql(spec,"r")}
                AND (r.${quote("ts")} IS NULL OR r.${quote("ts")}='')${contextSql}
                AND NOT EXISTS (SELECT 1 FROM main.${quote(item.table)} m WHERE ${item.semantic.map(column=>
                  `m.${quote(column)} IS r.${quote(column)}`).join(" AND ")})`)
              .run(...identityParams,...(context?.params??[]));
          }
        }
        const selectedMatch=(aliasName:string)=>item.semantic.map((column,at)=>
          `${aliasName}.${quote(column)} IS k.${quote(`k${at}`)}`).join(" AND ");
        const projection=(aliasName:string)=>item.columns.filter(column=>column!=="id")
          // EXCEPT's merge sort otherwise scans a whole store via its call-id index for each path.
          .map(column=>`+${aliasName}.${quote(column)}`).join(",");
        for(const identity of identities.values()) {
          const id=key(spec,identity);
          const params=spec.identity.map(field=>identity[field]!);
          const selected=(row:string)=>`EXISTS (SELECT 1 FROM temp.${quote(item.temp)} k WHERE ${selectedMatch(row)})`;
          const unrelated=(row:string)=>`NOT ${selected(row)}`;
          const differs=(predicate:(row:string)=>string)=>{
            const left=`SELECT ${projection("r")} FROM main.${quote(item.table)} r
              WHERE ${identitySql(spec,"r")} AND ${predicate("r")}`;
            const right=`SELECT ${projection("r")} FROM ${quote(alias)}.${quote(item.table)} r
              WHERE ${identitySql(spec,"r")} AND ${predicate("r")}`;
            return !!(active.query(`SELECT 1 FROM (${left} EXCEPT ${right}) LIMIT 1`).get(...params,...params)
              || active.query(`SELECT 1 FROM (${right} EXCEPT ${left}) LIMIT 1`).get(...params,...params));
          };
          if(differs(selected))selectedDifferences.add(id);
          if(differs(unrelated)) {
            unselectedDifferences.add(id);
            item.unselectedDifferences.add(id);
          }
        }
      }
      if(plan.selection)for(const id of unselectedDifferences)if(selectedDifferences.has(id))
        throw new Error(`Account-scoped reparse would publish a hybrid source identity: ${id}`);
      for(const id of unselectedDifferences)plan.partialIdentities.add(id);

      if(plan.selection) {
        plan.selectedDays ??= new Set();
        for(const item of prepared)if(item.columns.includes("ts")) {
          const match=item.semantic.map((column,at)=>`r.${quote(column)} IS k.${quote(`k${at}`)}`).join(" AND ");
          for(const database of ["main",alias]) {
            using timestamps=active.prepare(`SELECT DISTINCT r.ts
            FROM ${databaseSql(database)}.${quote(item.table)} r WHERE r.ts IS NOT NULL AND r.ts<>'' AND EXISTS
              (SELECT 1 FROM temp.${quote(item.temp)} k WHERE ${match})`);
            for(const row of timestamps.iterate() as Iterable<{ts:string}>) {
              const time=Date.parse(row.ts);
              if(!Number.isFinite(time))throw new Error(`Invalid selected account timestamp in ${item.table}`);
              plan.selectedDays.add(new Date(time).toISOString().slice(0,10));
            }
          }
        }
      }

      for(const item of prepared) {
        const selectedMatch=(aliasName:string)=>item.semantic.map((column,at)=>
          `${aliasName}.${quote(column)} IS k.${quote(`k${at}`)}`).join(" AND ");
        const unrelated=(row:string)=>`NOT EXISTS (SELECT 1 FROM temp.${quote(item.temp)} k WHERE ${selectedMatch(row)})`;
        for(const identity of identities.values()) {
          // Equal outside facts already occupy the right rows; do not delete and reinsert them.
          if(!item.unselectedDifferences.has(key(spec,identity)))continue;
          const params=spec.identity.map(field=>identity[field]!);
          active.query(`DELETE FROM ${quote(alias)}.${quote(item.table)}
            WHERE ${spec.identity.map(field=>`${quote(field)}=?`).join(" AND ")}
              AND NOT EXISTS (SELECT 1 FROM temp.${quote(item.temp)} k WHERE ${item.semantic.map((column,at)=>
                `${quote(column)} IS k.${quote(`k${at}`)}`).join(" AND ")})`).run(...params);
          const copied=item.columns.filter(column=>column!=="id");
          active.query(`INSERT INTO ${quote(alias)}.${quote(item.table)} (${copied.map(quote).join(",")})
            SELECT ${copied.map(column=>`r.${quote(column)}`).join(",")} FROM main.${quote(item.table)} r
            WHERE ${identitySql(spec,"r")} AND ${unrelated("r")}`).run(...params);
        }
      }
      plan.onReconciled?.([...identities.values()]);
    }).immediate();
  } finally {
    for(const table of temporary)try{active.exec(`DROP TABLE IF EXISTS temp.${quote(table)}`);}catch{}
    active.exec(`DETACH DATABASE ${quote(alias)}`);
  }
  return [...identities.values()].sort((a,b)=>key(spec,a).localeCompare(key(spec,b)));
}

function tableColumns(sqlite:Database,table:string):string[] {
  return (sqlite.query(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string}>).map(row=>row.name);
}

/** A disappearing file or parser skip cannot turn a forced read into a deletion. */
export function validateReparse(stage:Database,spec:ReparseSpec,plan:ReparsePlan):void {
  for(const identity of plan.identities) {
    const bookmark=spec.bookmarkTable ? stage.query(`SELECT 1 FROM ${spec.bookmarkTable} WHERE size>=0 AND mtime>=0 AND ${spec.identity.map(field=>`${field}=?`).join(" AND ")}`)
      .get(...spec.identity.map(field=>identity[field]!)) :stage.query("SELECT 1 FROM meta WHERE key=?").get(`opencode_snapshot:${identity.store}`);
    const reassigned=!bookmark && spec.bookmarkTable && spec.identity.includes("store") && identity.path
      && !stage.query(`SELECT 1 FROM ${spec.bookmarkTable} WHERE ${spec.identity.map(field=>`${field}=?`).join(" AND ")}`).get(...spec.identity.map(field=>identity[field]!))
      && stage.query(`SELECT 1 FROM ${spec.bookmarkTable} WHERE path=? AND size>=0 AND mtime>=0`).get(identity.path);
    if(!bookmark && !reassigned)throw new Error(`Source was not reread; previous data kept: ${JSON.stringify(identity)}`);
  }
  for(const bookmark of plan.protectedBookmarks) {
    const fields=Object.keys(bookmark),table=spec.bookmarkTable??"meta";
    stage.query(`INSERT OR REPLACE INTO ${table} (${fields.join(",")}) VALUES (${fields.map(()=>"?").join(",")})`)
      .run(...fields.map(field=>bookmark[field]!));
  }
}

export function reparseIdentities(spec:ReparseSpec,detected:ReparseIdentity[],plan:ReparsePlan):ReparseIdentity[] {
  const unavailable=new Set(plan.unavailable.map(row=>key(spec,row)));
  return [...new Map([...detected,...plan.identities].filter(row=>!unavailable.has(key(spec,row))).map(row=>[key(spec,row),row])).values()];
}
