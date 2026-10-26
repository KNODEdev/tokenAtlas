import {expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {prepareReparse,validateReparse,reparseIdentities} from "./reparse";

test("scoped reread touches only disposable bookmarks and preserves offline history",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-reread-"));
  const active=new Database(":memory:"),stage=new Database(":memory:");
  const spec={identity:["home","path"],bookmarkTable:"files"};
  const live=path.join(root,"live.jsonl"),old=path.join(root,"old.jsonl"),offline=path.join(root,"offline.jsonl");
  fs.writeFileSync(live,"available");fs.writeFileSync(old,"older");
  for(const db of [active,stage])db.exec("CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime INTEGER,PRIMARY KEY(home,path)); CREATE TABLE events(home TEXT,path TEXT,ts TEXT)");
  for(const [file,ts] of [[live,"2026-09-10"],[old,"2026-08-01"],[offline,"2026-09-11"]]) {
    for(const db of [active,stage])db.query("INSERT INTO files VALUES('pc',?,7,1)").run(file!);
    active.query("INSERT INTO events VALUES('pc',?,?)").run(file!,ts!);
  }
  try {
    const facts=active.query("SELECT * FROM events").all(),bookmarks=active.query("SELECT * FROM files").all();
    const plan=prepareReparse(active,stage,spec,["events"],{from:"2026-09-10",until:"2026-09-16"});
    expect(plan.identities).toEqual([{home:"pc",path:live}]);expect(plan.unavailable).toEqual([{home:"pc",path:offline}]);
    expect(stage.query("SELECT path FROM files WHERE size>=0 ORDER BY path").all()).toHaveLength(2);
    expect(()=>validateReparse(stage,spec,plan)).toThrow("previous data kept");
    // The same metadata (or an empty parsed file) is still an explicit successful reread.
    stage.query("UPDATE files SET size=7,mtime=1 WHERE path=?").run(live);
    stage.query("DELETE FROM files WHERE path=?").run(offline);
    validateReparse(stage,spec,plan);
    expect(stage.query("SELECT path FROM files WHERE path=?").get(offline)).toEqual({path:offline});
    expect(reparseIdentities(spec,[{home:"pc",path:offline}],plan)).toEqual([{home:"pc",path:live}]);
    expect(active.query("SELECT * FROM files").all()).toEqual(bookmarks);expect(active.query("SELECT * FROM events").all()).toEqual(facts);
  }finally{active.close();stage.close();removeTestFixture(root,{recursive:true,force:true});}
});

test("OpenCode snapshots with unchanged metadata remain forced publication identities",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-reread-oc-")),file=path.join(root,"opencode.sqlite");
  fs.writeFileSync(file,"source");const active=new Database(":memory:"),stage=new Database(":memory:");
  for(const db of [active,stage])db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE oc_events(store TEXT,ts TEXT)");
  const value=JSON.stringify({path:file,mtime:10});stage.query("INSERT INTO meta VALUES('opencode_snapshot:pc',?)").run(value);
  const spec={identity:["store"],bookmarkTable:null};
  try {
    const plan=prepareReparse(active,stage,spec,["oc_events"],{});expect(plan.identities).toEqual([{store:"pc"}]);
    stage.query("INSERT INTO meta VALUES('opencode_snapshot:pc',?)").run(value);validateReparse(stage,spec,plan);
    expect(reparseIdentities(spec,[],plan)).toEqual([{store:"pc"}]);
  }finally{active.close();stage.close();removeTestFixture(root,{recursive:true,force:true});}
});
