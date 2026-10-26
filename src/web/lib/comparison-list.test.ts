import {test,expect,spyOn} from 'bun:test';
import {comparisonList} from './comparison-list';
import {encodeComparisonCode} from '../../shared/comparison-code';
import {shareFixture} from '../../shared/comparison-code.fixture';
test('the local list survives a new store instance, adds no network call, deduplicates and removes entries',async()=>{
  const memory=new Map<string,string>(),storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>{memory.set(key,value)}};
  const deny=Object.assign(()=>{throw Error('External request forbidden')},{preconnect:()=>{throw Error('External request forbidden')}});
  const fetch=spyOn(globalThis,'fetch').mockImplementation(deny);
  try{
    const code=await encodeComparisonCode(shareFixture),first=comparisonList(storage);
    expect(await first.add(code)).toHaveLength(1);expect(await first.add(code)).toHaveLength(1);
    // The data belongs to the browser, independent of a server or component lifetime.
    const restarted=comparisonList(storage);expect((await restarted.read())[0]?.code).toBe(code);
    expect(await restarted.remove(code)).toEqual([]);expect(await first.read()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  }finally{fetch.mockRestore()}
});
