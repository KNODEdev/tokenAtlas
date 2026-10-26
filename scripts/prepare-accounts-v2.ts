import fs from "node:fs";
import path from "node:path";
import { prepareAccountsV2 } from "../src/config/accounts-v2";

export interface PrepareAccountsArtifacts {
  original: string;
  report: string;
  candidate: string | null;
  status: "ready" | "conflicts" | "already-v2";
}

/** Preparation artifacts only. The input and active config are never written. */
export function writeAccountsV2Preparation(input: string, outputDirectory: string): PrepareAccountsArtifacts {
  const source = fs.realpathSync(input);
  if (!fs.statSync(source).isFile()) throw new Error("--input must name a file");
  const directory = path.resolve(outputDirectory);
  if (source === directory) throw new Error("output collides with input");
  const original = path.join(directory, "accounts.original.json");
  const report = path.join(directory, "accounts.v2.report.json");
  const candidate = path.join(directory, "accounts.v2.candidate.json");
  const parent = fs.existsSync(directory) ? fs.realpathSync(directory) : directory;
  for (const artifact of [original, report, candidate]) {
    if (path.resolve(parent, path.basename(artifact)) === source || fs.existsSync(artifact))
      throw new Error(`output collides with an existing file: ${artifact}`);
  }
  const bytes = fs.readFileSync(source);
  const result = prepareAccountsV2(bytes);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(original, bytes, { flag: "wx" });
  fs.chmodSync(original, 0o444);
  fs.writeFileSync(report, JSON.stringify(result.report, null, 2) + "\n", { flag: "wx" });
  if (result.candidate) fs.writeFileSync(candidate, JSON.stringify(result.candidate, null, 2) + "\n", { flag: "wx" });
  return { original, report, candidate: result.candidate ? candidate : null, status: result.report.status };
}

function argument(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1] || argv[index + 1]!.startsWith("--") || argv.lastIndexOf(flag) !== index)
    throw new Error(`required once: ${flag} <path>`);
  return argv[index + 1]!;
}

export function prepareAccountsV2Cli(argv: string[]): PrepareAccountsArtifacts {
  if (argv.length !== 4) throw new Error("usage: bun scripts/prepare-accounts-v2.ts --input <file> --output <directory>");
  return writeAccountsV2Preparation(argument(argv, "--input"), argument(argv, "--output"));
}

if (import.meta.main) {
  try {
    const result = prepareAccountsV2Cli(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.status === "conflicts") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
