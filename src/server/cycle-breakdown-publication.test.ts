import { expect, test } from "bun:test";
import { PUBLICATION_VERIFICATION_TIMEOUT_MS, verifyPublicationProcesses } from "../../scripts/verify-exact-window-publication";

test("real HTTP/native worker: durable restart, killed publication, unrelated config and later latest-counter sample", async () => {
  const proof=await verifyPublicationProcesses(true);
  expect(proof.results.map(row=>row.workers)).toEqual([1,0,0,0,1,0]);
  expect(proof.results.map(row=>row.published)).toEqual([1,0,0,0,1,0]);
  expect(proof.results.every(row=>row.calls===2 && row.readerChanges===0)).toBe(true);
  expect(proof.fallbacks).toEqual({unusedRule:1,relevantRate:1,otherProject:1,relevantProject:1});
  expect(proof.results.map(row=>row.latest)).toEqual([true,true,true,true,false,false]);
},PUBLICATION_VERIFICATION_TIMEOUT_MS);
