export interface IngestTimings {
  discoveryMs:number;
  parseMs:number;
  poolMs:number;
  stageWriteMs:number;
  restMs:number;
  elapsedMs:number;
  overheadMs?:number;
  /** Nested details; worker.* sums worker time, overlapping the caller's wall-time partition. */
  steps?:Record<string,number>;
}
export type IngestTimingHandler=(timings:IngestTimings)=>void;
/** Caller phases partition wall time; poolMs overlaps them and includes queue/IPC/read/parse. */
export class IngestTimer {
  private readonly started=performance.now();
  private readonly values={discoveryMs:0,parseMs:0,stageWriteMs:0,overheadMs:0};
  private readonly steps:Record<string,number>={};
  private readonly active=new Map<string,{started:number;bucket:keyof IngestTimer["values"]}>();
  private pending=0;
  private poolStarted=0;
  private poolElapsed=0;
  private lastReported=0;
  private heartbeat:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  constructor(private readonly report?:IngestTimingHandler) {}
  measure<T>(phase:keyof IngestTimer["values"],work:()=>T):T {
    const started=performance.now();
    try{return work();}finally{this.add(phase,performance.now()-started);}
  }
  add(phase:keyof IngestTimer["values"],elapsed:number):void {this.values[phase]+=elapsed;}
  detail(name:string,elapsed:number):void {this.steps[name]=(this.steps[name]??0)+elapsed;}
  workerProfile(profile:unknown):void {
    const visit=(value:unknown,prefix:string)=>{
      if(!value||typeof value!=="object"||Array.isArray(value))return;
      for(const [key,item] of Object.entries(value)){
        if(typeof item==="number"&&key.endsWith("Seconds")&&Number.isFinite(item)&&item>=0)this.detail(`${prefix}${key.replace(/(?:Elapsed)?Seconds$/,"Ms")}`,item*1000);
        else if(item&&typeof item==="object")visit(item,`${prefix}${key}.`);
      }
    };
    visit(profile,"worker.");
  }
  begin(name:string,bucket:keyof IngestTimer["values"]="overheadMs"):()=>void {
    const started=performance.now();this.active.set(name,{started,bucket});this.emit();
    let ended=false;
    return ()=>{if(ended)return;ended=true;this.active.delete(name);const elapsed=performance.now()-started;this.values[bucket]+=elapsed;this.steps[name]=(this.steps[name]??0)+elapsed;this.emit();};
  }
  step<T>(name:string,work:()=>T,bucket:keyof IngestTimer["values"]="overheadMs"):T {
    const end=this.begin(name,bucket);try{return work();}finally{end();}
  }
  async pool<T>(work:()=>Promise<T>):Promise<T> {
    if(this.pending++===0)this.poolStarted=performance.now();
    try{return await work();}finally{if(--this.pending===0)this.poolElapsed+=performance.now()-this.poolStarted;}
  }
  snapshot():IngestTimings {
    const now=performance.now(),elapsed=now-this.started,values={...this.values},steps={...this.steps};
    for(const [name,active] of this.active){const duration=now-active.started;values[active.bucket]+=duration;steps[name]=(steps[name]??0)+duration;}
    return {...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,Math.round(value)])) as typeof this.values,
      steps:Object.fromEntries(Object.entries(steps).map(([key,value])=>[key,Math.round(value)])),
      poolMs:Math.round(this.poolElapsed+(this.pending?performance.now()-this.poolStarted:0)),
      restMs:Math.round(Math.max(0,elapsed-Object.values(values).reduce((sum,value)=>sum+value,0))),elapsedMs:Math.round(elapsed)};
  }
  emit(force=false):void {
    if(this.report && !this.heartbeat && !this.stopped){this.heartbeat=setInterval(()=>this.emit(),1000);this.heartbeat.unref();}
    const now=performance.now();
    if(force || now-this.lastReported>=500){this.lastReported=now;try{this.report?.(this.snapshot());}catch{/* Advisory telemetry cannot reject facts. */}}
  }
  stop():void {if(this.stopped)return;this.stopped=true;if(this.heartbeat)clearInterval(this.heartbeat);this.emit(true);}
}

export function sumIngestTimings(values:readonly IngestTimings[]):IngestTimings {
  const steps:Record<string,number>={};
  for(const value of values)for(const [key,ms] of Object.entries(value.steps??{}))steps[key]=(steps[key]??0)+ms;
  return {...Object.fromEntries(["discoveryMs","parseMs","poolMs","stageWriteMs","restMs","elapsedMs","overheadMs"].map(key=>
    [key,values.reduce((sum,value)=>sum+((value as unknown as Record<string,number>)[key]??0),0)])) as unknown as IngestTimings,steps};
}
