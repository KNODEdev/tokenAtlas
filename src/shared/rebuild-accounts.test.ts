import {expect,test} from "bun:test";
import {parseRebuildOptions} from "./analysis-rebuild";
import {normalizeRebuildAccounts} from "./rebuild-accounts";
import {vendorsForScope} from "../sync/contracts";

test("account selection canonicalizes historical identities and preserves collector boundaries",()=>{
  const accounts=normalizeRebuildAccounts([{vendor:"claude",account:" B "},{vendor:"codex",account:"A"},{vendor:"claude",account:"a"}]);
  expect(accounts).toEqual([{vendor:"codex",account:"a"},{vendor:"claude",account:"a"},{vendor:"claude",account:"b"}]);
  expect(parseRebuildOptions({scope:"7d",accounts})).toEqual({scope:"7d",mode:"archive",accounts});
  expect(vendorsForScope({kind:"accounts",accounts})).toEqual(["codex","claude"]);
  for(const invalid of [null,[],[{}],[{vendor:"gauges",account:"a"}],[{vendor:"claude",account:"a\u0000"}],
    [{vendor:"claude",account:"a"},{vendor:"claude",account:" A "}]])expect(()=>normalizeRebuildAccounts(invalid)).toThrow();
  expect(()=>parseRebuildOptions({accounts,vendors:["claude"]})).toThrow("cannot be combined");
});
