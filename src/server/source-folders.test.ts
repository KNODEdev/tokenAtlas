import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSourceFolders, listSourceFolders } from "./source-folders";

test("folder browsing lists hidden profile folders and directories, never files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-browse-"));
  try {
    fs.mkdirSync(path.join(root, ".codex-mr")); fs.mkdirSync(path.join(root, "another"));
    fs.writeFileSync(path.join(root, "auth.json"), "must not be listed");
    const listing = await listSourceFolders(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(path.dirname(root));
    expect(listing.folders.map(folder => folder.name)).toEqual([".codex-mr", "another"]);
    expect((await listSourceFolders(listing.folders[0]!.path)).folders).toEqual([]);
    expect((await handleSourceFolders(new Request(`http://localhost:7331/api/source-folders?path=${encodeURIComponent(path.join(root, "absent"))}`)))).toHaveProperty("status", 400);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("folder browsing rejects relative, network and cross-origin requests", async () => {
  for (const folder of ["relative", "\\\\server\\share", "//server/share"]) await expect(listSourceFolders(folder)).rejects.toThrow();
  expect((await handleSourceFolders(new Request("http://localhost:7331/api/source-folders", { headers: { origin: "https://example.test" } }))).status).toBe(403);
  expect((await handleSourceFolders(new Request("http://localhost:7331/api/source-folders", { method: "POST" }))).status).toBe(405);
});
