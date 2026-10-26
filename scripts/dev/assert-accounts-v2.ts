import { isFirstRun, readAccountsV2 } from "../../src/config/accounts-document";
import { configFile } from "../../src/config/paths";
import { activeDatabasePath } from "../../src/db";

try {
  const file = configFile("accounts.json");
  if (isFirstRun(file, activeDatabasePath())) {
    console.log(`First run on this machine: no account configuration yet (${file}).`);
    console.log("The app opens the setup wizard, which chooses the archive and writes accounts.json.");
  } else {
    readAccountsV2(file);
    console.log("Accounts v2 configuration valid.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
