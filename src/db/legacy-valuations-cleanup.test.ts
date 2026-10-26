import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "./sqlite";

const migration = fs.readFileSync(new URL("../../drizzle/0041_stage4_legacy_removal.sql", import.meta.url), "utf8");
const cleanup = migration.split("--> statement-breakpoint").find(sql => sql.includes("DELETE FROM event_valuations"))!;

test("W9 removes only provably pre-v8 subscription valuation keys and preserves all reusable values", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE event_valuations(provider TEXT,identity TEXT,variant TEXT,day TEXT,
    facts_stamp TEXT,rules_stamp TEXT,source_stamp TEXT,value TEXT,PRIMARY KEY(provider,identity,variant)) WITHOUT ROWID`);
  const rows = [
    {label:"old-actual", provider:"anthropic", slot:"claude-old", variant:"dated-actual-api", remove:true},
    {label:"old-standard", provider:"google", slot:"agy1", variant:"dated-standard-api", remove:true},
    {label:"old-global", provider:"openrouter", slot:"opencode", variant:"dated-actual-api", remove:true},
    {label:"source", provider:"anthropic", slot:"claude/pc-main", variant:"dated-actual-api", remove:false},
    {label:"unassigned", provider:"google", slot:null, variant:"dated-actual-api", remove:false},
    {label:"ambiguous", provider:"xai", slot:"account/with-slash", variant:"dated-standard-api", remove:false},
    {label:"other-variant", provider:"anthropic", slot:"old-account", variant:"future-variant", remove:false},
    {label:"codex", provider:"codex", slot:"old-looking", variant:"dated-actual-api", remove:false},
  ];
  const insert = db.query("INSERT INTO event_valuations VALUES(?,?,?,'2026-09-01','facts','rules','reset',?)");
  for (const row of rows) insert.run(row.provider, JSON.stringify(["home","source-id",row.slot,row.label]), row.variant,
    '{"amount":1.23456789012345,"reason":null,"label":'+JSON.stringify(row.label)+'}');
  for (const identity of ['invalid-json', JSON.stringify(["home","source-id","old-account"]),
    JSON.stringify(["home","source-id",{account:"unknown"},"ambiguous-object"])])
    insert.run("anthropic",identity,"dated-actual-api",'{"amount":null,"reason":"missing-rate"}');
  const all = () => db.query("SELECT * FROM event_valuations ORDER BY provider,identity,variant").all() as Array<Record<string,string>>;
  const keep = all().filter(row => !rows.some(input => input.remove && row.identity === JSON.stringify(["home","source-id",input.slot,input.label])));
  try {
    expect(cleanup).toBeDefined();
    db.transaction(() => db.exec(cleanup))();
    expect(db.query("SELECT changes() n").get()).toEqual({n:3});
    expect(all()).toEqual(keep);
    db.transaction(() => db.exec(cleanup))();
    expect(db.query("SELECT changes() n").get()).toEqual({n:0});
    expect(all()).toEqual(keep);
  } finally {db.close();}
});
