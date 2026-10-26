import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "../db/sqlite";
import { canonicalJson, digest } from "../config/canonical-json";
import { ProbeFactConflict, createProbeCollection, quarantineProbeConflict, sameProbeDimensions, validateCanonicalProbe,
  type CanonicalProbe, type ProbePayload } from "../db/probe-facts";
import { journalEntryId } from "../providers/core/journal-receipts";

// SQL `json_extract(payload,'$.provider')=? AND json_extract(payload,'$.ts')=?` never matches a NULL.
const coordinateKey = (c: CanonicalProbe): string | null =>
  c.payload.provider == null || c.payload.ts == null ? null : JSON.stringify([c.payload.provider, c.payload.ts]);

/** Empty-stage acceptance: validate in order, buffer native SQL writes, preserve duplicate semantics. */
export class GaugeFirstFill {
  private readonly receipts = new Map<string,string>();
  private readonly headers = new Map<string,string>();
  private readonly counters = new Map<string,string>();
  private readonly deliveries = new Set<string>();
  private readonly recent = new Map<string,CanonicalProbe>();
  private readonly rows = new Map<string,SQLQueryBindings[][]>();
  private readonly projected = new Set<string>();
  private readonly legacyFacts = new Map<string,CanonicalProbe>();
  private readonly coordinates = new Map<string,Array<{id:string;payload:string}>>();
  private readonly namespace:string;
  constructor(private readonly db: Database) {
    for(const table of ["gauge_journal_receipts","probe_observations","probe_counters","probe_fact_deliveries"])
      if(db.query(`SELECT 1 FROM ${table} LIMIT 1`).get())throw new Error("Gauge first fill requires an empty stage");
    this.namespace=(db.query("SELECT namespace FROM probe_fact_backfill_checkpoints WHERE id='local'").get() as {namespace:string}).namespace;
  }
  private append(table:string,row:SQLQueryBindings[]):void {
    const pending=this.rows.get(table)??[];pending.push(row);this.rows.set(table,pending);
    if(pending.length>=100)this.flush();
  }
  acceptJournal(line:string,file:string,ts:string):boolean {
    const id=journalEntryId(line);if(id===null)return true;
    const hash=createHash("sha256").update(file).update("\0").update(line.trim()).digest("hex");
    const prior=this.receipts.get(id);
    if(prior){if(prior!==hash)throw new ProbeFactConflict("unknown",prior,line,"Gauge journal entry identity conflict");return false;}
    this.receipts.set(id,hash);this.append("gauge_journal_receipts",[id,hash,ts]);return true;
  }
  acceptFact(c:CanonicalProbe,alreadyValidated=false):boolean {
    if(!this.db.inTransaction)throw new Error("Canonical probe requires fact transaction");
    if(!alreadyValidated)validateCanonicalProbe(c);
    const header=canonicalJson(c.header),prior=this.headers.get(c.observation_id);
    if(prior && prior!==header)throw new ProbeFactConflict(c.header.provider,prior,canonicalJson(c),"observation-header-conflict");
    const old=this.counters.get(c.counter_id);
    if(old && old!==c.payload_digest){
      this.flush();
      const row=this.db.query("SELECT * FROM probe_counters WHERE id=?").get(c.counter_id);
      throw new ProbeFactConflict(c.header.provider,canonicalJson(row),canonicalJson(c),"counter-identity-conflict");
    }
    this.recent.delete(c.counter_id);this.recent.set(c.counter_id,c);
    if(this.recent.size>128)this.recent.delete(this.recent.keys().next().value!);
    if(!prior){this.headers.set(c.observation_id,header);this.append("probe_observations",[c.observation_id,header]);}
    if(old)return false;
    this.counters.set(c.counter_id,c.payload_digest);
    const payload=canonicalJson(c.payload),coordinates=coordinateKey(c);
    if(coordinates!==null){const same=this.coordinates.get(coordinates)??[];same.push({id:c.counter_id,payload});this.coordinates.set(coordinates,same);}
    this.append("probe_counters",[c.counter_id,c.observation_id,canonicalJson(c.discriminator),payload,c.payload_digest]);return true;
  }
  /** `legacyJournalProbe` for an empty stage: same fact, ambiguity evidence and unresolved-origin mapping. */
  legacy(row:Record<string,unknown>,evidenceKey:string):CanonicalProbe {
    const id=digest(["legacy-journal",evidenceKey]),known=this.legacyFacts.get(id);
    if(known)return known;
    const c=createProbeCollection([row],true)[0]!;
    this.acceptFact(c);
    // Counters accepted earlier at the same provider/time, in insertion order like the coordinate index.
    for(const other of this.coordinates.get(coordinateKey(c)??"")??[])
      if(other.id!==c.counter_id && sameProbeDimensions(JSON.parse(other.payload) as ProbePayload,c.payload))
        quarantineProbeConflict(this.db,new ProbeFactConflict(c.header.provider,other.payload,canonicalJson(c),"legacy-equivalence-unresolved"));
    this.append("probe_fact_legacy_map",[id,this.namespace,null,digest(c.payload),c.counter_id,"legacy-journal-unresolved-origin"]);
    this.legacyFacts.set(id,c);return c;
  }
  delivery(c:CanonicalProbe,key:string,evidence:Record<string,unknown>):void {
    const id=digest([c.counter_id,key,evidence.role??null,evidence.received_by??null]);
    if(this.deliveries.has(id))return;
    this.deliveries.add(id);this.append("probe_fact_deliveries",[id,c.counter_id,canonicalJson(evidence)]);
  }
  handled(c:CanonicalProbe):boolean{return this.projected.has(c.counter_id);}
  base(id:string):CanonicalProbe|null{return this.recent.get(id)??null;}
  map(c:CanonicalProbe,legacyId:number|null,reason:string):void {
    const id=digest([this.namespace,legacyId,c.payload_digest,c.counter_id,""]);
    this.append("probe_fact_legacy_map",[id,this.namespace,legacyId,c.payload_digest,c.counter_id,reason]);
    this.projected.add(c.counter_id);
  }
  flush():void {
    // Observation parents precede counters, which precede deliveries.
    for(const table of ["gauge_journal_receipts","probe_observations","probe_counters","probe_fact_deliveries","probe_fact_legacy_map"]){
      const pending=this.rows.get(table);if(!pending?.length)continue;
      const tuple=`(${pending[0]!.map(()=>"?").join(",")})`;
      this.db.query(`INSERT INTO ${table} VALUES ${pending.map(()=>tuple).join(",")}`).run(...pending.flat());pending.length=0;
    }
  }
}
