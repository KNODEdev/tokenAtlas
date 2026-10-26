import type { Database } from "bun:sqlite";
import { isAnalysisRevisionTrackingTrigger } from "../db/analysis";
import { isFactDayRevisionTrigger } from "../db/fact-day-revisions";

/** A disposable stage never publishes its private revision clocks. */
export function omitStageAnalysisTracking(stage:Database):void {
  const triggers=stage.query("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all() as {name:string;tbl_name:string;sql:string}[];
  const owned=triggers.filter(trigger=>isAnalysisRevisionTrackingTrigger(stage,trigger.name,trigger.tbl_name,trigger.sql)
    || isFactDayRevisionTrigger(stage,trigger.name,trigger.tbl_name,trigger.sql));
  stage.transaction(()=>{
    for(const trigger of owned)stage.exec(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`);
  }).immediate();
}
