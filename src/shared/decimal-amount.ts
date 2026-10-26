/** Exact arithmetic over decimal strings, including Number's scientific serialization.
 * This preserves supplied values; it cannot recover precision lost before serialization. */
function parts(value:string):{coefficient:bigint;scale:number} {
  const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if(!match)throw new Error("Invalid decimal amount");
  const exponent=Number(match[4]??0),fraction=match[3]??"";
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000||fraction.length>1000)throw new Error("Decimal amount exceeds supported precision");
  const scale=fraction.length-exponent;
  const coefficient=BigInt(`${match[1]}${match[2]}${fraction}`);
  return scale<0?{coefficient:coefficient*10n**BigInt(-scale),scale:0}:{coefficient,scale};
}
function format(coefficient:bigint,scale:number):string {
  if(coefficient===0n)return "0";
  const sign=coefficient<0n?"-":"",digits=(coefficient<0n?-coefficient:coefficient).toString().padStart(scale+1,"0");
  return sign+(scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`.replace(/0+$/,"").replace(/\.$/,""):digits);
}
export function addDecimalAmounts(left:string,right:string):string {
  const a=parts(left),b=parts(right),scale=Math.max(a.scale,b.scale);
  return format(a.coefficient*10n**BigInt(scale-a.scale)+b.coefficient*10n**BigInt(scale-b.scale),scale);
}
/** A running exact sum: each value is parsed once and the total formatted once, as chained adds would give it. */
export class DecimalSum {
  private coefficient=0n;
  private scale=0;
  add(value:string):void {
    const next=parts(value);
    if(next.scale>this.scale){this.coefficient*=10n**BigInt(next.scale-this.scale);this.scale=next.scale;}
    this.coefficient+=next.coefficient*10n**BigInt(this.scale-next.scale);
  }
  toString():string { return format(this.coefficient,this.scale); }
}
export function subtractDecimalAmounts(left:string,right:string):string {
  return addDecimalAmounts(left,right.startsWith("-")?right.slice(1):`-${right}`);
}
export function decimalAmount(value:number):string {
  if(!Number.isFinite(value)||value<0)throw new Error("Invalid registered monetary value");
  return addDecimalAmounts("0",String(value));
}
