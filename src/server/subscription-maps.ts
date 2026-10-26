import path from 'node:path';
import type {Database} from '../db/sqlite';
import type {AccountsV2} from '../config/accounts-v2';
import {ARCHIVE_LOGICAL_ROOT} from '../config/paths';
import {ACCOUNT_PERIODS,loadPeriods} from '../db/period-store';
import {effectiveDatedPeriods} from './account-periods';
import {normEraVendor,type EraDeclaration} from './eras';
import {archiveFolderOf} from './event-source';
import {loadAccountResolver} from './account-resolver';
import {restoreSubscriptionHomes,codexPhysicalSourceHomes,SubscriptionHomeConflictError} from './capacity-equivalents';

const normPath=(p:string)=>p.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();

/** Shared mappings need no HTTP entry module, including in the maintenance worker. */
export function periodEras(sqlite:Database,accounts:AccountsV2):EraDeclaration[]{
  const sources=accounts.sources;
  return effectiveDatedPeriods(loadPeriods(sqlite,ACCOUNT_PERIODS)).map(period=>{
    const source=sources.find(row=>row.vendor===normEraVendor(period.provider)&&archiveFolderOf(row.home,ARCHIVE_LOGICAL_ROOT)?.key===normPath(period.subject));
    const identity=accounts.subscriptions.find(row=>row.id.toLowerCase()===period.value.toLowerCase());
    return {id:period.value,vendor:period.provider,home:source?.home??path.join(ARCHIVE_LOGICAL_ROOT,period.subject),
      source_home:source?.source_home,machine:source?.machine,account_key:identity?.account_key,from:period.from,until:period.until??undefined};
  });
}
export function subscriptionMaps(sqlite:Database,accounts:AccountsV2):{homeToSubId:Map<string,string>;subIdToHomes:Map<string,string[]>}{
  const resolver=loadAccountResolver(sqlite,accounts.subscriptions),now=new Date().toISOString();
  const entries:Array<[string,string]>=[],subIdToHomes=new Map<string,string[]>();
  for(const period of effectiveDatedPeriods(loadPeriods(sqlite,ACCOUNT_PERIODS))){
    const key=period.value.toLowerCase();
    const home=accounts.sources.find(source=>source.vendor===normEraVendor(period.provider)&&archiveFolderOf(source.home,ARCHIVE_LOGICAL_ROOT)?.key===normPath(period.subject))?.home
      ??path.join(ARCHIVE_LOGICAL_ROOT,period.subject);
    const list=subIdToHomes.get(key)||[];
    if(!list.some(known=>normPath(known)===normPath(home)))list.push(home);
    subIdToHomes.set(key,list);
  }
  for(const source of accounts.sources){
    const key=archiveFolderOf(source.home,ARCHIVE_LOGICAL_ROOT)?.key;if(!key)continue;
    const account=resolver.resolve(source.vendor,key,null,now).account;if(!account)continue;
    for(const home of [source.home,source.source_home])if(home)entries.push([normPath(home),account]);
  }
  const map=new Map<string,string>();
  for(const [home,account] of entries){
    const prior=map.get(home);if(prior&&prior!==account)throw new SubscriptionHomeConflictError(home,prior,account);
    map.set(home,account);
  }
  return {homeToSubId:restoreSubscriptionHomes([...map],codexPhysicalSourceHomes(accounts.sources),accounts.sources),subIdToHomes};
}
