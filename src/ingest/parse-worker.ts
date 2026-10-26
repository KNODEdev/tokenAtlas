import { fingerprint } from "../sync/file-fingerprint";
import { validateArchivedJsonl } from "../sync/jsonl-inspection";
import type { ParseFormats, ParseRequest, ParseResponse } from "./parse-pool";

declare const self: Worker;

const formats: Partial<{ [F in keyof ParseFormats]: (input: ParseFormats[F]["input"]) => Promise<ParseFormats[F]["output"]> }> = {
  async fingerprint({ file }) {
    return { fingerprint: fingerprint(file) };
  },
  async validateJsonl({ file }) {
    validateArchivedJsonl(file);
    return {};
  },
};

async function runFormat(format: keyof ParseFormats, input: ParseFormats[keyof ParseFormats]["input"]): Promise<unknown> {
  const task = formats[format];
  if (!task) throw new Error(`No Bun worker task for ${format}`);
  return task(input as never);
}

const workerProfile = { files: 0, parseMs: 0, structuredCloneSendMs: 0 };
self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, format, input } = event.data;
  if (event.data.snapshot) { self.postMessage({ id, ok: true, value: workerProfile }); return; }
  const started = performance.now(), receivedEpoch = performance.timeOrigin + started;
  let response: ParseResponse;
  try {
    response = { id, ok: true, value: await runFormat(format, input) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    response = { id, ok: false, message: error instanceof Error ? error.message : String(error),
      ...(typeof code === "string" ? { code } : {}) };
  }
  if (event.data.profile) {
    const parseMs = performance.now() - started;
    workerProfile.files++; workerProfile.parseMs += parseMs;
    response.profile = { parseMs, queueMs: Math.max(0, receivedEpoch - (event.data.sentEpochMs ?? receivedEpoch)),
      sentEpochMs: performance.timeOrigin + performance.now() };
    const sending = performance.now();
    self.postMessage(response);
    workerProfile.structuredCloneSendMs += performance.now() - sending;
  } else self.postMessage(response);
};
