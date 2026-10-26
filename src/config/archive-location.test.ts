import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindArchiveIdentity, locationContains, prepareArchiveConnection, readArchiveIdentity } from "./archive-location";

function fixture(run:(root:string,db:Database)=>void) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-archive-location-")),db=new Database(":memory:");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY)");
  try {run(root,db);} finally {
    db.close();
    if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error("Unsafe fixture cleanup");
    fs.rmSync(root,{recursive:true,force:true});
  }
}
test("a new local archive is created without OneDrive and keeps its identity when connected",()=>fixture((root,db)=>{
  const archive=path.join(root,"nested","local-archive"),database=path.join(root,"local","atlas.sqlite");
  const created=prepareArchiveConnection(archive,"create",{database,sqlite:db});
  expect(readArchiveIdentity(archive)).toBe(created.archiveId);
  bindArchiveIdentity(db,created.archiveId);
  db.exec("INSERT INTO events VALUES(1)");
  expect(prepareArchiveConnection(archive,"connect",{database,sqlite:db}).archiveId).toBe(created.archiveId);
  expect(fs.readdirSync(archive)).toEqual([".archive-inventory"]);
}));
test("connecting an unknown folder or creating over existing files preserves all contents",()=>fixture((root,db)=>{
  const archive=path.join(root,"unrelated"),database=path.join(root,"atlas.sqlite");
  fs.mkdirSync(archive);fs.writeFileSync(path.join(archive,"important.txt"),"keep");
  for(const action of ["connect","create"] as const)expect(()=>prepareArchiveConnection(archive,action,{database,sqlite:db})).toThrow();
  expect(fs.readdirSync(archive)).toEqual(["important.txt"]);
  expect(fs.readFileSync(path.join(archive,"important.txt"),"utf8")).toBe("keep");
  fs.mkdirSync(path.join(archive,"config"));
  fs.mkdirSync(path.join(archive,"codex"));
  expect(()=>prepareArchiveConnection(archive,"connect",{database,sqlite:db})).toThrow("not a recognized archive");
  expect(fs.existsSync(path.join(archive,".archive-inventory"))).toBe(false);
}));
test("a populated index cannot mix another archive, but an exact archive copy keeps its binding",()=>fixture((root,db)=>{
  const archive=path.join(root,"archive"),other=path.join(root,"other"),database=path.join(root,"atlas.sqlite");
  const created=prepareArchiveConnection(archive,"create",{database});
  prepareArchiveConnection(other,"create",{database});
  bindArchiveIdentity(db,created.archiveId);db.exec("INSERT INTO events VALUES(1)");
  expect(()=>prepareArchiveConnection(other,"connect",{database,currentRoot:archive,sqlite:db})).toThrow("different archive");
  const copy=path.join(root,"copy");fs.cpSync(archive,copy,{recursive:true});
  expect(prepareArchiveConnection(copy,"connect",{database,currentRoot:archive,sqlite:db}).archiveId).toBe(created.archiveId);
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({n:1});
}));
test("a legacy populated index cannot switch to an unbound directory and active databases stay local",()=>fixture((root,db)=>{
  db.exec("INSERT INTO events VALUES(1)");
  const current=path.join(root,"old"),target=path.join(root,"new");
  expect(()=>prepareArchiveConnection(target,"create",{database:path.join(root,"atlas.sqlite"),currentRoot:current,sqlite:db})).toThrow("different archive");
  expect(fs.existsSync(target)).toBe(false);
  expect(()=>prepareArchiveConnection(target,"create",{database:path.join(target,"atlas.sqlite")})).toThrow("outside the archive");
  expect(locationContains(path.join(root,"archive"),path.join(root,"archive2"))).toBe(false);
}));
