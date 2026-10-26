import {test,expect,spyOn} from 'bun:test';
import {encodeComparisonCode,decodeComparisonCode,isoWeek,ComparisonCodeError,comparisonMatches} from './comparison-code';
import type {RateWindow} from './subscription-rate';
import {shareFixture} from "./comparison-code.fixture";
async function pack(payload:unknown){const base=btoa(JSON.stringify(payload)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(base));
  const check=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('').slice(0,24);return 'TA1-'+base+'.'+check;}
test('whitelisted fields and exact privacy rounding survive a local round trip',async()=>{
  const code=await encodeComparisonCode(shareFixture),decoded=await decodeComparisonCode(code);
  expect(decoded).toMatchObject({v:1,week:'2026-W40',vendor:'claude',plan:'claude-max-20x',pp:64,value100:1250,rate:26.8,hours:33,priceDate:'2026-10-04',quality:'conditional'});
  expect(decoded.mix.map(m=>m[1]).sort()).toEqual([30,70]);
  const text=JSON.stringify(decoded);
  for(const privateValue of ['person@example.com','secret-subscription-week','private name','private-version','private-subscription','C:/secret/customer/file','2026-10-04T11:00','2026-10-13T11:30','1233.4','32.88','26.81521'])expect(text).not.toContain(privateValue);
  expect(Object.keys(decoded).sort()).toEqual(['v','week','vendor','plan','pp','value100','priceDate','rate','hours','mix','quality'].sort());
  expect(comparisonMatches(decoded,shareFixture)).toBe(true);
});
test('tampering, truncation, invalid fields, extra identifying fields and future formats are rejected',async()=>{
  const code=await encodeComparisonCode(shareFixture),payload=await decodeComparisonCode(code);
  await expect(decodeComparisonCode(code.slice(0,-1))).rejects.toMatchObject({reason:'malformed'});
  const edited=code.slice(0,10)+(code[10]==='A'?'B':'A')+code.slice(11);
  await expect(decodeComparisonCode(edited)).rejects.toMatchObject({reason:'integrity'});
  await expect(decodeComparisonCode('TA2-future')).rejects.toMatchObject({reason:'newer_version'});
  await expect(decodeComparisonCode(await pack({...payload,v:2}))).rejects.toMatchObject({reason:'newer_version'});
  await expect(decodeComparisonCode(await pack({...payload,account:'secret'}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(decodeComparisonCode(await pack({...payload,pp:64.3}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(decodeComparisonCode(await pack({...payload,value100:1251}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(decodeComparisonCode(await pack({...payload,mix:[['customer@example.com',100]]}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(decodeComparisonCode(await pack({...payload,priceDate:'2026-02-30'}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(decodeComparisonCode(await pack({...payload,week:'2025-W53'}))).rejects.toMatchObject({reason:'invalid_fields'});
  await expect(encodeComparisonCode({...shareFixture,plan_id:'customer-plan'})).rejects.toMatchObject({reason:'unsupported_plan'});
});
test('code operations issue no fetch and week rollover uses UTC ISO weeks',async()=>{
  const deny=Object.assign(()=>{throw Error('Network forbidden')},{preconnect:()=>{throw Error('Network forbidden')}});
  const fetch=spyOn(globalThis,'fetch').mockImplementation(deny);
  try{await decodeComparisonCode(await encodeComparisonCode(shareFixture));expect(fetch).not.toHaveBeenCalled()}finally{fetch.mockRestore()}
  expect(isoWeek('2027-01-01T12:00:00Z')).toBe('2026-W53');expect(isoWeek('2026-01-01')).toBe('2026-W01');
});
