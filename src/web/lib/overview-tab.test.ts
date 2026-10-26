import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { OVERVIEW_TAB_KEY } from "./overview-tab";

test("Models opens the Overview tab under the key the approved Overview reads", () => {
  // VendorOverview.tsx is hash-locked, so the key is repeated here instead of imported there.
  const overview = fs.readFileSync(path.join(import.meta.dir, "../components/VendorOverview.tsx"), "utf8");
  expect(overview).toContain(`const TAB_KEY = "${OVERVIEW_TAB_KEY}";`);
  expect(overview).toContain('label: t("Models and traffic", "Modele i ruch")');
});
