import {expect,test} from "bun:test";
import {sourceHealthStatus} from "./data-clock";
import type {SourceHealthRow} from "../shared/source-health";

test("health age changes preserve unavailable, failed and historical semantics",()=>{
  const row={vendor:"codex",machine:"pc",configured:true,last_session:"2026-09-15T12:00:00Z",last_meter:null} as SourceHealthRow;
  const time=Date.parse("2026-09-16T12:00:00Z");
  expect(sourceHealthStatus(row,time,24)).toBe("current");
  expect(sourceHealthStatus(row,time+60000,24)).toBe("older");
  expect(sourceHealthStatus({...row,error:"failed"},time,24)).toBe("error");
  expect(sourceHealthStatus({...row,historical:true,error:"failed"},time,24)).toBe("history");
  expect(sourceHealthStatus({...row,last_session:null},time,24)).toBe("no-sessions");
});
