import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCREEN_TITLES, SCREEN_TITLES_PL } from "../../src/web/lib/screens";
const root = resolve(import.meta.dir, "../..");
test("Tibo is absent from application navigation, routes, lazy screens and read API", () => {
  expect(Object.keys(SCREEN_TITLES)).not.toContain("tibo");
  expect(Object.keys(SCREEN_TITLES_PL)).not.toContain("tibo");
  for (const file of ["src/web/App.tsx", "src/web/components/Sidebar.tsx", "src/web/screens/deferred.ts",
    "src/web/screen-styles.ts", "src/server/data-views.ts", "src/web/lib/api.ts"]) {
    expect(readFileSync(resolve(root, file), "utf8")).not.toMatch(/tibo|Tibo/);
  }
});
