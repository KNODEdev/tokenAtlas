import { fingerprint } from "./file-fingerprint";
import type { FingerprintResult } from "./fingerprint-batch";

declare const self: Worker;

self.onmessage = (event: MessageEvent<string>) => {
  let result: FingerprintResult;
  try { result = { fingerprint: fingerprint(event.data) }; }
  catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(result);
};
