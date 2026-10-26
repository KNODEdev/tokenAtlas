import fs from "node:fs";

/** Only for final fixture teardown, never for deletions a test is exercising. */
export function removeTestFixture(directory: string, options: fs.RmDirOptions): void {
  if (process.env.TOKENATLAS_KEEP_TEST_FIXTURES === "1") {
    console.info(`[retained test fixture] ${directory}`);
    return;
  }
  fs.rmSync(directory, options);
}
