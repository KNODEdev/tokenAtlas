/** Synthetic SQL-only benchmark; creates/deletes its own temporary files, never user data. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOverviewReadFixture } from "./lib/overview-read-fixture";
import { measureOverviewRead } from "./review-overview";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-overview-bench-"));
try {
  const file = path.join(dir, "synthetic.sqlite");
  createOverviewReadFixture(file);
  const report = measureOverviewRead(file);
  console.log(JSON.stringify({ ...report, machine_label: "SYNTHETIC" }, null, 2));
  if (report.status !== "measured") process.exitCode = 1;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
