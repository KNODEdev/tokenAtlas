import { activeDatabasePath } from "../../src/db";
import { configFile } from "../../src/config/paths";
import { readAccountsV2 } from "../../src/config/accounts-document";

// Resolve Settings through the application's own entry points; never open or prepare its database.
console.log(JSON.stringify({ version: 1, database: activeDatabasePath(),
  accounts_file: configFile("accounts.json"),
  subscriptions: readAccountsV2(configFile("accounts.json")).subscriptions }));
