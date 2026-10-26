import {test,expect} from "bun:test";
import {codexHomeSource} from "./event-source";

test("a local Codex path shared by two machines maps only to this machine's archive folder",()=>{
  const sources=[
    {vendor:"codex",machine:"MAIN",source_home:"C:/Users/sample_a/.codex",home:"/archive/codex/main"},
    {vendor:"codex",machine:"LAPTOP",source_home:"C:/Users/sample_a/.codex",home:"/archive/codex/laptop"},
  ];
  expect(codexHomeSource("C:/Users/sample_a/.codex",sources,"/archive","MAIN")).toBe("codex/main");
  expect(codexHomeSource("C:/Users/sample_a/.codex",sources,"/archive","LAPTOP")).toBe("codex/laptop");
  expect(codexHomeSource("C:/Users/sample_a/.codex",sources,"/archive","UNKNOWN")).toBeNull();
  expect(codexHomeSource("/archive/codex/laptop",sources,"/archive","MAIN")).toBe("codex/laptop");
  expect(codexHomeSource("C:/Users/sample_a/.codex",[...sources,{...sources[0]!,home:"/archive/codex/conflict"}],"/archive","MAIN")).toBeNull();
});
