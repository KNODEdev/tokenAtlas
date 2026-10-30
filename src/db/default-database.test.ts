import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDatabasePath } from ".";

test("a new Windows installation keeps its database under LOCALAPPDATA; an existing default stays put", () => {
  const legacy = path.join(os.homedir(), ".tokenatlas", "atlas.sqlite");
  const local = path.join("C:/Users/example/AppData/Local", "tokenAtlas", "data", "atlas.sqlite");
  expect(defaultDatabasePath({ LOCALAPPDATA: "C:/Users/example/AppData/Local" }, "win32")).toBe(fs.existsSync(legacy) ? legacy : local);
  expect(defaultDatabasePath({ LOCALAPPDATA: "C:/Users/example/AppData/Local" }, "linux")).toBe(legacy);
});
