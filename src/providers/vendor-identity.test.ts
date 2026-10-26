import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { fileURLToPath } from "node:url";
import { applyDrizzleMigrations } from "../db/migrate";
import { readVendorProfile, scanVendorProfiles } from "./vendor-identity";
import { pollVendorAccount, rememberedVendorAccounts, resolveVendorDiscovery } from "../server/vendor-discovery";
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-vendor-"));dirs.push(root);return root;}
function write(root:string,file:string,value:unknown){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(value));}
test("Claude scopes identity to account and organization without exporting credentials",()=>{
 const root=fixture();write(root,".claude.json",{oauthAccount:{emailAddress:"ONE@example.com",accountUuid:"one",organizationUuid:"org"}});
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET",subscriptionType:"pro"}});
 const row=readVendorProfile("claude",path.join(root,".claude"),"pc");
 expect(row.key).toBe("claude:one:org");expect(row.email).toBe("one@example.com");expect(row.plan).toBe("pro");expect(JSON.stringify(row)).not.toContain("SECRET");
});
test("a settings-only local Claude file does not hide the sibling account on repeated discovery",()=>{
 const root=fixture();write(root,".claude.json",{oauthAccount:{emailAddress:"one@example.com",accountUuid:"one",organizationUuid:"org"}});
 write(root,".claude/.claude.json",{firstStartTime:"2026-10-18T12:42:29Z",pluginUsage:{}});
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET",subscriptionType:"max"}});
 const options={home:root,platform:"linux",machine:"pc",pool:[],vendor:"claude" as const};
 for(let attempt=0;attempt<2;attempt++){
  const profiles=scanVendorProfiles(options);
  const account=resolveVendorDiscovery(profiles,[],[],"pc").accounts[0]!;
  expect(profiles).toHaveLength(1);expect(profiles[0]).toMatchObject({key:"claude:one:org",email:"one@example.com",error:null});
  expect(account).toMatchObject({current:true,key:"claude:one:org"});
  expect(JSON.stringify(profiles)).not.toContain("SECRET");
 }
});
test("a local Claude identity or explicit sign-out takes precedence over the sibling account",()=>{
 const root=fixture();write(root,".claude.json",{oauthAccount:{accountUuid:"old",emailAddress:"old@example.com"}});
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET"}});
 const home=path.join(root,".claude");
 write(root,".claude/.claude.json",{oauthAccount:{accountUuid:"new",emailAddress:"new@example.com"}});
 expect(readVendorProfile("claude",home,"pc").key).toBe("claude:new:personal");
 write(root,".claude/.claude.json",{oauthAccount:null});
 expect(readVendorProfile("claude",home,"pc")).toMatchObject({key:null,error:"No unambiguous signed-in account in this profile."});
 fs.writeFileSync(path.join(home,".claude.json"),"{");
 expect(readVendorProfile("claude",home,"pc").key).toBeNull();
});
test("Grok refuses ambiguous stored accounts and exports only identity metadata",()=>{
 const root=fixture();write(root,".grok/auth.json",{issuer:{user_id:"one",email:"one@example.com",refresh_token:"SECRET",create_time:"2026-09-09T00:00:00Z"}});
 const row=readVendorProfile("grok",path.join(root,".grok"),"pc");expect(row.key).toBe("grok:one:personal");expect(JSON.stringify(row)).not.toContain("SECRET");
 write(root,".grok/auth.json",{a:{user_id:"one"},b:{user_id:"two"}});expect(readVendorProfile("grok",path.join(root,".grok"),"pc").key).toBeNull();
});
test("duplicate pool accounts merge while Gemini CLI stays separate from Antigravity",()=>{
 const root=fixture();write(root,".gemini/google_accounts.json",{active:"one@example.com",old:["old@example.com"]});
 const profiles=scanVendorProfiles({home:root,platform:"linux",machine:"pc",pool:[{id:"a",profile:"one",port:1,google:"one@example.com"},{id:"b",profile:"two",port:2,google:"one@example.com"}]});
 const discovery=resolveVendorDiscovery(profiles,[],[],"pc");expect(discovery.accounts).toHaveLength(2);
 expect(discovery.accounts.find(a=>a.key.startsWith("antigravity"))?.profiles).toHaveLength(2);
 expect(discovery.accounts.find(a=>a.key.startsWith("gemini-cli"))?.profiles[0]?.error).toContain("no quota reader");
});
test("login changes preserve the previous subscription, even with the same email",()=>{
 const p={vendor:"claude" as const,surface:"claude-code" as const,home:"/one/.claude",login:"one",machine:"pc",key:"claude:one",email:"one@example.com",plan:"pro",error:null};
 const declarations=[{id:"claude1",vendor:"claude",account:p.email}];
 const first=resolveVendorDiscovery([p],declarations,[],"pc");
 const next=resolveVendorDiscovery([{...p,key:"claude:two"}],declarations,first.accounts,"pc");
 expect(next.accounts.find(a=>a.id==="claude1")?.current).toBe(false);
 expect(next.accounts.find(a=>a.key==="claude:two")?.id).not.toBe("claude1");
});
test("detected identity survives restart without inventing quota",async()=>{
 const root=fixture();write(root,".gemini/google_accounts.json",{active:"one@example.com"});
 const p=readVendorProfile("gemini",path.join(root,".gemini"),"pc");
 const account=resolveVendorDiscovery([p],[],[],"pc").accounts[0]!;
 const db=new Database(":memory:");
 try {
  applyDrizzleMigrations(drizzle(db),fileURLToPath(new URL("../../drizzle",import.meta.url)));
  await pollVendorAccount(db,account,p);
  expect(rememberedVendorAccounts(db)[0]?.id).toBe(account.id);
  const before=db.query("SELECT subject, used_percent FROM probe_windows").get() as any;
  expect(before.used_percent).toBeNull();
  expect(before.subject).toBe(account.id);
 } finally {db.close();}
});
import { claudeProbeAdapter } from "./adapters/claude";
import { handleClaudeLimit, handleRoster, type AppContext } from "../server/api";
import { buildEraIndex } from "../server/eras";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "../server/probe-reader.fixture";
import { prepareClaudeCardMetadataFixture } from "../server/claude-card-metadata.fixture";
test("a login change during an in-flight Claude reading discards the result",async()=>{
 const root=fixture();write(root,".claude.json",{oauthAccount:{accountUuid:"one",emailAddress:"one@example.com"}});
 write(root,".claude/.claude.json",{pluginUsage:{}});
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET",subscriptionType:"pro"}});
 const p=readVendorProfile("claude",path.join(root,".claude"),"pc");
 const account=resolveVendorDiscovery([p],[],[],"pc").accounts[0]!;
 const db=new Database(":memory:");const request=claudeProbeAdapter.request;
 try{
  applyDrizzleMigrations(drizzle(db),fileURLToPath(new URL("../../drizzle",import.meta.url)));
  claudeProbeAdapter.request=async()=>{write(root,".claude.json",{oauthAccount:{accountUuid:"two",emailAddress:"two@example.com"}});return {usage:{seven_day:{utilization:42}},plan:"pro"};};
  await pollVendorAccount(db,account,p);
  expect((db.query("SELECT COUNT(*) n FROM probe_windows").get() as any).n).toBe(0);
 }finally{claudeProbeAdapter.request=request;db.close();}
});
test("discovered Claude details and roster do not reuse another subscription",async()=>{
 const db=new Database(":memory:");
 try{
  applyDrizzleMigrations(drizzle(db),fileURLToPath(new URL("../../drizzle",import.meta.url)));
  const root=fixture();write(root,".claude.json",{oauthAccount:{accountUuid:"one",emailAddress:"one@example.com"}});
  const p=readVendorProfile("claude",path.join(root,".claude"),"pc");
  const discovery=resolveVendorDiscovery([p],[],[],"pc");
  const ctx={sqlite:db,accounts:{subscriptions:[]},homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([]),eraErrors:[],
   claudeGauge:{subscription:"old",plan:"max"},grokGauge:{},rateCards:{version:1,currency:"USD",unit:"per 1M",vendors:{}},plans:{},cycles:{},plansCatalog:{provider_groups:[]},rootDir:"",homeConflict:null,vendorDiscovery:discovery} as unknown as AppContext;
  const account=discovery.accounts[0]!;
  prepareProbeReaderFixture(db,[probeReaderFixtureSource("claude",account.id),probeReaderFixtureSource("glm","glm")]);
  fillUsageLedgerFixture(db, ctx.rateCards);
  prepareWindowUsageFixture(db, { rateCards: ctx.rateCards, claudeGauge: ctx.claudeGauge });
  prepareClaudeCardMetadataFixture(db, [account.id, "old"]);
  const response=await handleClaudeLimit(ctx,new URL(`http://test/api/claude-limit?account=${account.id}`)).json() as any;
  expect(response.plan).not.toBe("max");
  expect(response.current).toBeNull();
  const roster=await (await handleRoster(ctx,new URL("http://test/api/roster"))).json() as any;
  expect(roster.accounts.find((a:any)=>a.id===account.id).vendor_account).toBe("one@example.com");
  expect(handleClaudeLimit(ctx,new URL("http://test/api/claude-limit?account=missing")).status).toBe(404);
 }finally{db.close();}
});
import { buildClaudeLimit } from "../server/claude-limit";
import { fillUsageLedgerFixture } from "../server/usage-ledger.fixture";
import { prepareWindowUsageFixture } from "../server/window-usage.fixture";
import { declareClaudeLabelPeriods } from "../server/subscription-reader.fixture";
test("Claude report counts only the selected subscription's tokens",()=>{
 const db=new Database(":memory:");
 try {
  applyDrizzleMigrations(drizzle(db),fileURLToPath(new URL("../../drizzle",import.meta.url)));
  const insert=db.query("INSERT INTO claude_events(store,call_id,ts,path,subscription_id,in_uncached,out_total) VALUES(?,?,?,?,?,?,?)");
  insert.run("one","a","2026-09-09T01:00:00Z","/one","one",100,20);
  insert.run("two","b","2026-09-09T01:00:00Z","/two","two",9000,1000);
  declareClaudeLabelPeriods(db);
  prepareProbeReaderFixture(db,[probeReaderFixtureSource("claude","one"),probeReaderFixtureSource("glm","glm")]);
  const gauge={subscription:"one",plan:"pro",observations:[{ts:"2026-09-09T12:00:00Z",reset_ts:"2026-09-15T00:00:00Z",window_start_ts:"2026-09-08T00:00:00Z",percent:{all:30}}]};
  // The maintenance worker publishes the ledger and the gauge observation's stored sums.
  const card={version:1,currency:"USD",unit:"per 1M",vendors:{}} as never;
  fillUsageLedgerFixture(db,card,["claude"]);
  prepareWindowUsageFixture(db,{rateCards:card,claudeGauge:gauge,manualCapacity:()=>[],cycles:{windows:[]}});
  const report=buildClaudeLimit(db,gauge,()=>null,"2026-09-09T12:00:00Z");
  expect(report.observations[0]?.spend.calls).toBe(1);
  expect(report.observations[0]?.spend.gross).toBe(120);
 }finally{db.close();}
});
test("Claude verifies the authenticated account before requesting usage",async()=>{
 const calls:string[]=[];
 await expect(claudeProbeAdapter.request({subscription:"one",expectedIdentity:{accountId:"one",organizationId:null,email:"one@example.com"}},
  {credentials:{token:"test",expires_at:null,subscription_type:"pro"},fetchJson:async(url:string)=>{calls.push(url);return {ok:true,status:200,body:{account:{uuid:"two",email:"two@example.com"}}} as any;}})).rejects.toThrow("does not match");
 expect(calls).toEqual(["https://api.anthropic.com/api/oauth/profile"]);
});
test("Claude plan comes from the profile's rate-limit tier, not from the label of an older token",()=>{
 const root=fixture();write(root,".claude.json",{oauthAccount:{emailAddress:"one@example.com",accountUuid:"one",organizationUuid:"org",
  organizationRateLimitTier:"default_claude_max_5x",profileFetchedAt:Date.parse("2026-09-12T09:30:00Z")}});
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET",subscriptionType:"pro"}});
 const row=readVendorProfile("claude",path.join(root,".claude"),"pc");
 expect([row.plan,row.planTier,row.planReadAt]).toEqual(["max-5x","default_claude_max_5x","2026-09-12T09:30:00.000Z"]);
 write(root,".claude.json",{oauthAccount:{emailAddress:"one@example.com",accountUuid:"one",organizationRateLimitTier:"default_claude_ai",profileFetchedAt:1}});
 expect(readVendorProfile("claude",path.join(root,".claude"),"pc").plan).toBe("pro");
 // After Max ends the token still says `max`; the profile's Pro tier wins.
 write(root,".claude/.credentials.json",{claudeAiOauth:{accessToken:"SECRET",subscriptionType:"max"}});
 expect(readVendorProfile("claude",path.join(root,".claude"),"pc").plan).toBe("pro");
 // An unknown tier names no plan, and the token's label does not stand in for it.
 write(root,".claude.json",{oauthAccount:{emailAddress:"one@example.com",accountUuid:"one",organizationRateLimitTier:"default_raven",profileFetchedAt:1}});
 expect(readVendorProfile("claude",path.join(root,".claude"),"pc").plan).toBeNull();
 // Without a tier the token's label is all there is.
 write(root,".claude.json",{oauthAccount:{emailAddress:"one@example.com",accountUuid:"one"}});
 expect(readVendorProfile("claude",path.join(root,".claude"),"pc").plan).toBe("max");
});
test("an account's plan is the one read most recently on any machine",()=>{
 const p={vendor:"claude" as const,surface:"claude-code" as const,home:"/one/.claude",login:"one",key:"claude:one",email:"one@example.com",error:null};
 const laptop={...p,machine:"laptop",plan:"max-20x",planTier:"default_claude_max_20x",planReadAt:"2026-10-23T14:48:51.809Z"};
 const main={...p,machine:"pc",plan:"pro",planTier:"default_claude_ai",planReadAt:"2026-10-23T15:21:13.844Z"};
 const remembered=[{id:"claude1",vendor:"claude" as const,key:"claude:one",email:p.email,plan:"max-20x",current:false,profiles:[laptop]}];
 expect(resolveVendorDiscovery([main],[],remembered,"pc").accounts[0]?.plan).toBe("pro");
 // A local profile not refreshed yet does not undo a newer reading from another machine.
 expect(resolveVendorDiscovery([{...laptop,machine:"pc"}],[],[{...remembered[0]!,profiles:[{...main,machine:"laptop"}]}],"pc")
  .accounts[0]?.plan).toBe("pro");
});
