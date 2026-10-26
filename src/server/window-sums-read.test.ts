import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { readWindowSums, WindowUsagePreparing } from "./window-usage";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE window_usage(provider TEXT,account TEXT,counter TEXT,window_id TEXT,cycle TEXT,rail TEXT,
    PRIMARY KEY(provider,account,counter,window_id))`);
  const insert = db.query("INSERT INTO window_usage VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i=0;i<1500;i++) insert.run("codex","seat","weekly",String(i),JSON.stringify({ index:i }),JSON.stringify({ tokens:i }));
    insert.run("claude","seat","weekly","0",'{"index":9000}',"{}");
    insert.run("codex","other","weekly","0",'{"index":8000}',"{}");
    insert.run("codex","seat","five-hour","0",'{"index":7000}',"{}");
  })();
  return db;
}

test("a bounded window read fetches only the requested rows and columns, preserving caller order",()=>{
  const db=fixture(),query=db.query.bind(db),returned:number[]=[];
  const watch=spyOn(db,"query").mockImplementation(((sql:string)=>{
    const statement=query(sql);
    if(sql.startsWith("SELECT window_id,"))return {all:(...params:unknown[])=>{
      const rows=(statement.all as (...params:unknown[])=>unknown[])(...params);returned.push(rows.length);return rows;
    }};
    return statement;
  }) as typeof db.query);
  try {
    const value=readWindowSums(db,"CODEX","SEAT","weekly",[{id:"1499"},{id:"0"},{id:"1499"}],["rail"]);
    expect([...value.keys()]).toEqual(["1499","0"]);
    expect(value.get("1499")?.rail.tokens).toBe(1499);
    expect(value.get("0")?.rail.tokens).toBe(0);
    expect(Object.keys(value.get("0")!)).toEqual(["rail"]);
    expect(returned).toEqual([2]);
  }finally{watch.mockRestore();db.close();}
});

test("large requested sets, absent publications and unrelated invalid JSON retain their contracts",()=>{
  const db=fixture();
  try {
    const windows=Array.from({length:1500},(_,i)=>({id:String(i)}));
    expect(readWindowSums(db,"codex","seat","weekly",windows,["cycle","rail"]).size).toBe(1500);
    db.query("UPDATE window_usage SET cycle='invalid' WHERE provider='codex' AND account='seat' AND counter='weekly' AND window_id='1499'").run();
    expect(JSON.stringify(readWindowSums(db,"codex","seat","weekly",[{id:"0"}],["cycle"]).get("0"))).toBe('{"cycle":{"index":0}}');
    expect(()=>readWindowSums(db,"codex","seat","weekly",[{id:"missing"}],["cycle"])).toThrow(WindowUsagePreparing);
    expect(()=>readWindowSums(db,"codex","seat","weekly",[{id:"1499"}],["cycle"])).toThrow();
    expect(readWindowSums(db,"codex","seat","weekly",[],["cycle"]).size).toBe(0);
  }finally{db.close();}
});
