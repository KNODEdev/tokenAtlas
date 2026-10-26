import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareAccountsV2Cli, writeAccountsV2Preparation } from "./prepare-accounts-v2";

function fixture(run: (root: string, input: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-accounts-v2-"));
  const input = path.join(root, "accounts.json");
  try { run(root, input); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("CLI requires both paths, retains exact input bytes and writes a validated candidate", () => fixture((root, input) => {
  const original = Buffer.from('{\r\n  "subscriptions": [{"id":"a","home":"${ARCHIVE}/codex/a","vendor":"codex"}]\r\n}\r\n');
  fs.writeFileSync(input, original);
  expect(() => prepareAccountsV2Cli(["--input", input])).toThrow("usage");
  const result = prepareAccountsV2Cli(["--input", input, "--output", path.join(root, "out")]);
  expect(result.status).toBe("ready");
  expect(fs.readFileSync(result.original)).toEqual(original);
  expect(fs.statSync(result.original).mode & 0o222).toBe(0);
  expect(JSON.parse(fs.readFileSync(result.candidate!, "utf8"))).toMatchObject({ version: 2, subscriptions: [{ id: "a" }], sources: [{ home: "${ARCHIVE}/codex/a" }] });
  expect(JSON.parse(fs.readFileSync(result.report, "utf8"))).toMatchObject({ status: "ready", original_bytes: original.length });
  expect(fs.readFileSync(input)).toEqual(original);
  expect(() => writeAccountsV2Preparation(input, path.join(root, "out"))).toThrow("existing file");
}));

test("conflict writes report and exact original only, never a guessed candidate", () => fixture((root, input) => {
  const original = JSON.stringify({ subscriptions: [
    { id: "one", vendor: "codex", machine: "MAIN", home: "archive/one", source_home: "C:/one" },
    { id: "two", vendor: "codex", machine: "MAIN", home: "archive/one", source_home: "C:/two" },
  ] });
  fs.writeFileSync(input, original);
  const result = writeAccountsV2Preparation(input, path.join(root, "out"));
  expect(result).toMatchObject({ status: "conflicts", candidate: null });
  expect(fs.readFileSync(result.original, "utf8")).toBe(original);
  expect(JSON.parse(fs.readFileSync(result.report, "utf8")).conflicts[0].code).toBe("archive-profiles");
  expect(fs.existsSync(path.join(root, "out", "accounts.v2.candidate.json"))).toBe(false);
}));

test("CLI rejects input/output collision", () => fixture((root, input) => {
  fs.writeFileSync(input, '{"subscriptions":[]}');
  expect(() => writeAccountsV2Preparation(input, input)).toThrow("collides");
  const output = path.join(root, "out");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "accounts.original.json"), "keep");
  expect(() => writeAccountsV2Preparation(input, output)).toThrow("existing file");
  expect(fs.readFileSync(path.join(output, "accounts.original.json"), "utf8")).toBe("keep");
}));
