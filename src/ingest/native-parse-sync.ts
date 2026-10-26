import fs from "node:fs";
import path from "node:path";
import { NativeParserError, nativeParserBinary, type ParseFormats, type ParseResponse } from "./parse-pool";
import { temporaryDirectory } from "../config/temporary-storage";
import { activeDatabasePath } from "../db";
import type { CodexFilePreparation } from "./codex-storage";

/** Single framed native request for synchronous source-proof verification. Importers use ParsePool. */
export function runNativeSync(format: "codex", input: ParseFormats["codex"]["input"]): CodexFilePreparation {
  if (!fs.existsSync(nativeParserBinary())) throw new NativeParserError("Native parser is missing; rebuild it with _dev.bat");
  const json = Buffer.from(JSON.stringify({ id: 1, format, input }));
  const frame = Buffer.allocUnsafe(json.length + 4);
  frame.writeUInt32LE(json.length); json.copy(frame, 4);
  const result = Bun.spawnSync([nativeParserBinary(), "1"], {
    stdin: frame, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
  if (result.exitCode !== 0 || result.stdout.length < 4 || result.stdout.readUInt32LE(0) !== result.stdout.length - 4) {
    throw new NativeParserError("Native parser failed; rebuild it with _dev.bat");
  }
  const response = JSON.parse(result.stdout.subarray(4).toString("utf8")) as ParseResponse;
  if (response.id !== 1 || typeof response.ok !== "boolean") throw new NativeParserError("Invalid native response");
  if (!response.ok) throw Object.assign(new NativeParserError(response.message), response.code ? { code: response.code } : {});
  return response.value as CodexFilePreparation;
}

/** The witness API has bytes, rather than a source path. Never re-open a mutable original. */
export function prepareCodexBytes(bytes: Uint8Array): CodexFilePreparation {
  const root = temporaryDirectory(activeDatabasePath());
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "tokenatlas-source-proof-"));
  const file = path.join(directory, "source.jsonl");
  try {
    fs.writeFileSync(file, bytes);
    return runNativeSync("codex", { file, size: bytes.byteLength });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
