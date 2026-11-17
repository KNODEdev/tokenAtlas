import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const preload = path.join(import.meta.dir, "test-environment.ts");
const retained: string[] = [];
afterEach(() => {
  for (const root of retained.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function run(source: string, keep = "0") {
  const env: NodeJS.ProcessEnv = { ...process.env, TOKENATLAS_KEEP_TEST_FIXTURES: keep };
  delete env.TOKENATLAS_TEST_ROOT;
  const result = spawnSync(process.execPath, ["--preload", preload, "-e", source], {
    cwd: path.resolve(import.meta.dir, ".."), env, encoding: "utf8", timeout: 20_000,
  });
  const root = result.stdout?.match(/^ROOT=(.+)$/m)?.[1]?.trim();
  if (root) retained.push(root);
  expect(result.error).toBeUndefined();
  expect(root).toBeTruthy();
  return { ...result, root: root! };
}

const announce = `console.log('ROOT=' + process.env.TOKENATLAS_TEST_ROOT);`;

test("the creator removes its scratch environment on success and failure", () => {
  for (const code of [0, 7]) {
    const result = run(`${announce} await Bun.write(process.env.TOKENATLAS_DB, 'fixture'); process.exit(${code});`);
    expect(result.status).toBe(code);
    expect(fs.existsSync(result.root)).toBe(false);
  }
});

test("a child leaves the inherited environment for its creating process", () => {
  const result = run(`${announce}
    const child = Bun.spawnSync([process.execPath, '--preload', ${JSON.stringify(preload)}, '-e',
      "console.log(process.env.TOKENATLAS_TEST_ROOT)"], { env: process.env });
    if (child.exitCode !== 0 || child.stdout.toString().trim() !== process.env.TOKENATLAS_TEST_ROOT
      || !(await import('node:fs')).existsSync(process.env.TOKENATLAS_TEST_ROOT)) process.exit(9);
  `);
  expect(result.status).toBe(0);
  expect(fs.existsSync(result.root)).toBe(false);
});

test("explicit retention keeps the environment for inspection", () => {
  const result = run(`${announce} await Bun.write(process.env.TOKENATLAS_DB, 'fixture');`, "1");
  expect(result.status).toBe(0);
  expect(fs.readFileSync(path.join(result.root, "test.sqlite"), "utf8")).toBe("fixture");
});
