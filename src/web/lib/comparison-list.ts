import {decodeComparisonCode,type ComparisonPayload,ComparisonCodeError} from '../../shared/comparison-code';
const KEY='tokenatlas.comparison-codes.v1';
export interface ComparisonEntry {code:string;payload:ComparisonPayload}
export function comparisonList(storage:Pick<Storage,'getItem'|'setItem'>){
  return {
    async read():Promise<ComparisonEntry[]>{
      const saved=storage.getItem(KEY);if(!saved)return [];
      let value:{version:unknown;codes:unknown};try{value=JSON.parse(saved)}catch{throw new ComparisonCodeError('malformed')}
      if(typeof value.version==='number'&&value.version>1)throw new ComparisonCodeError('newer_version');
      if(value.version!==1||!Array.isArray(value.codes)||value.codes.length>100||value.codes.some(c=>typeof c!=='string'))throw new ComparisonCodeError('malformed');
      return Promise.all(value.codes.map(async code=>({code,payload:await decodeComparisonCode(code)})));
    },
    write(entries:readonly ComparisonEntry[]):void {
      if(entries.length>100)throw new Error('comparison_list_full');
      storage.setItem(KEY,JSON.stringify({version:1,codes:entries.map(e=>e.code)}));
    },
    async add(code:string):Promise<ComparisonEntry[]>{
      const entries=await this.read(),clean=code.trim(),payload=await decodeComparisonCode(clean);
      if(entries.some(e=>e.code===clean))return entries;
      const next=[...entries,{code:clean,payload}];this.write(next);return next;
    },
    async remove(code:string):Promise<ComparisonEntry[]>{
      const next=(await this.read()).filter(e=>e.code!==code);this.write(next);return next;
    }
  };
}
