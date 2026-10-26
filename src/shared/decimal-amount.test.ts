import {test,expect} from "bun:test";
import {addDecimalAmounts,subtractDecimalAmounts,decimalAmount,DecimalSum} from "./decimal-amount";
test("decimal aggregation preserves tiny and large values without per-event rounding",()=>{
  expect(addDecimalAmounts("9007199254740993.1","0.2")).toBe("9007199254740993.3");
  expect(subtractDecimalAmounts("0.3","0.1")).toBe("0.2");
  expect(addDecimalAmounts("1e-20","2e-20")).toBe("0.00000000000000000003");
  expect(decimalAmount(1e21)).toBe("1000000000000000000000");
  expect(subtractDecimalAmounts("0","0.001")).toBe("-0.001");
  expect(addDecimalAmounts("-0.001","0.001")).toBe("0");
  for(const value of [NaN,Infinity,-1])expect(()=>decimalAmount(value)).toThrow();
});
test("a running decimal sum equals chained additions",()=>{
  const values=["0","0.1","1e-20","9007199254740993.1","-0.2","2.50","1e3","0.001"];
  const sum=new DecimalSum();
  for(const value of values)sum.add(value);
  expect(sum.toString()).toBe(values.reduce(addDecimalAmounts,"0"));
  expect(new DecimalSum().toString()).toBe("0");
});
