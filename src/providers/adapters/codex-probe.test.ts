import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { codexProbeAdapter, codexProbeCommand } from "./codex";

test("Windows probes prefer a native executable over a potentially broken npm shim", () => {
  const requested: string[] = [];
  expect(codexProbeCommand("win32", command => {
    requested.push(command);
    return "C:\\Program Files\\Codex\\codex.exe";
  })).toEqual({ command: "C:\\Program Files\\Codex\\codex.exe", shell: false });
  expect(requested).toEqual(["codex.exe"]);
  expect(codexProbeCommand("win32", () => null)).toEqual({ command: "codex", shell: true });
  expect(codexProbeCommand("linux", () => "/usr/bin/codex")).toEqual({ command: "/usr/bin/codex", shell: false });
});

test.each([false, true])("a probe completes initialization before reading limits (initialization error: %s)", async initializationError => {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const methods: string[] = [];
  let killed = false;
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { killed = true; } });
  const spawn = spyOn(childProcess, "spawn").mockImplementation((() => child) as unknown as typeof childProcess.spawn);
  stdin.on("data", data => {
    const message = JSON.parse(data.toString());
    methods.push(message.method);
    if (message.method === "initialize") stdout.write(JSON.stringify({ id: 1,
      ...(initializationError ? { error: { message: "fixture initialization rejected" } } : { result: {} }) }) + "\n");
    if (message.method === "account/rateLimits/read") stdout.write(JSON.stringify({ id: 2,
      result: { rateLimits: { primary: { usedPercent: 68, windowDurationMins: 10080 } } } }) + "\n");
  });
  try {
    const request = codexProbeAdapter.request({ home: "fixture", account: "fixture", timeoutMs: 1000 }, {
      credentials: { home: "fixture" }, fetchJson: async () => { throw new Error("HTTP is not used"); },
    });
    if (initializationError) {
      await expect(request).rejects.toThrow("fixture initialization rejected");
      expect(methods).toEqual(["initialize"]);
    } else {
      expect((await request).rateLimits?.primary?.usedPercent).toBe(68);
      expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    }
    expect(killed).toBe(true);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  } finally { spawn.mockRestore(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});
