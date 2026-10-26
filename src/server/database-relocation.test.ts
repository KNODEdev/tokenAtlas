import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import { createFetchHandler, type AppContext } from "./api";

test("relocation API validates before restart and exposes the active database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-route-"));
  const source = path.join(directory,"source.sqlite");
  const destination = path.join(directory,"new.sqlite");
  const sqlite = new Database(source);
  applyDrizzleMigrations(drizzle(sqlite));
  let requested: string | undefined;
  const ctx = { sqlite, dbPath: source, accounts: { subscriptions: [] }, homeToSubId: new Map(), subIdToHomes: new Map(),
    eraErrors: [], homeConflict: null, claudeGauge: {}, grokGauge: {},
    rateCards: { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {} },
    relocateDatabase: (target: string) => { requested = target; },
  } as unknown as AppContext;
  try {
    const handle = createFetchHandler(ctx);
    const post = (target: string) => handle(new Request("http://fixture/api/setup/database", {
      method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({destination:target}),
    }));
    expect((await post(source)).status).toBe(409);
    expect(requested).toBeUndefined();
    const accepted = await post(destination);
    expect(accepted.status).toBe(202);
    expect(requested).toBe(destination);
    expect(fs.existsSync(destination)).toBe(false);
    const state = await handle(new Request("http://fixture/api/setup/database"));
    expect((await state.json()).database).toBe(source);
    requested = undefined;
    const folder = path.join(directory, "selected-folder");
    const folderAccepted = await handle(new Request("http://fixture/api/setup/database", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: folder }),
    }));
    expect(folderAccepted.status).toBe(202);
    expect(requested as string | undefined).toBe(path.join(folder, path.basename(source)));
    requested = undefined;
    const invalidFolder = await handle(new Request("http://fixture/api/setup/database", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "relative" }),
    }));
    expect(invalidFolder.status).toBe(409);
    expect(requested).toBeUndefined();
    const previousLocalState = process.env.TOKENATLAS_LOCAL_STATE;
    process.env.TOKENATLAS_LOCAL_STATE = path.join(directory, "machine-state");
    try {
      const changeTemp = (directory: unknown) => handle(new Request("http://fixture/api/setup/temporary", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory }),
      }));
      expect((await changeTemp(42)).status).toBe(409);
      expect((await changeTemp(directory)).status).toBe(409);
      const scratch = path.join(directory, "scratch");
      const savedTemp = await changeTemp(scratch);
      expect(savedTemp.status).toBe(200);
      expect(await savedTemp.json()).toEqual({ root: scratch });
      expect(ctx.dbPath).toBe(source);
      expect(requested).toBeUndefined();
      expect((await post(path.join(scratch, "atlas.sqlite"))).status).toBe(409);
    } finally {
      if (previousLocalState === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
      else process.env.TOKENATLAS_LOCAL_STATE = previousLocalState;
    }
    ctx.databaseRelocating = true;
    expect((await post(destination)).status).toBe(503);
  } finally {
    await ctx.analysisReader?.close();
    sqlite.close(true);
    await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
