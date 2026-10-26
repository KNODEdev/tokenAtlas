import { periodEras } from "./subscription-maps";
import type { AppContext } from "./app-context-types";
import { loadAccountResolver } from "./account-resolver";
import { restoreSubscriptionHomes } from "./capacity-equivalents";
import { Database, setTransactionContext } from "../db/sqlite";
import { withReadSnapshotAsync } from "../db/analysis";
import { buildEraIndex } from "./eras";
import { dataVersion, DATA_VERSION_HEADER } from "./data-version";
import { contextRequested } from "./codex-context-preview";
import { directReadHandler, type DirectReadAnswer, type DirectReadWork } from "./direct-read";


/**
 * Builds one stored-row screen (`DIRECT_READ_HANDLERS`) off the HTTP thread, from one read snapshot of
 * its own read-only connection. The connection stays open between requests so its page cache is reused;
 * every request still reads in a new snapshot, so it sees everything published before it.
 */
const worker = self as unknown as Worker;
let open: { path: string; db: Database } | null = null;
const connection = (dbPath: string) => {
  if (open?.path === dbPath) return open.db;
  open?.db.close();
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA busy_timeout=3000; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
  open = { path: dbPath, db };
  return db;
};
worker.onmessage = async (message: MessageEvent<DirectReadWork | { close: true }>) => {
  if (message.data.close) { open?.db.close(); open = null; worker.postMessage({ closed: true }); return; }
  const work = message.data;
  let answer: DirectReadAnswer;
  try {
    const url = new URL(work.url, "http://local");
    setTransactionContext(`${url.pathname}${url.search}`.slice(0, 240));
    const handler = directReadHandler(url.pathname);
    if (!handler) throw new Error(`Not a direct read: ${url.pathname}`);
    const db = connection(work.dbPath);
    const { subHomes, ...context } = work.context;
    answer = await withReadSnapshotAsync(db, async () => {
      // Account eras and the resolver come from the same snapshot as the rows.
      const ctx: AppContext = { ...context, sqlite: db, dbPath: work.dbPath, rateCards: work.rates,
        homeToSubId: restoreSubscriptionHomes(work.homes, work.sourceHomes, context.accounts.sources ?? []),
        subIdToHomes: new Map(subHomes), eras: buildEraIndex(periodEras(db, context.accounts), "instant"),
        resolver: loadAccountResolver(db, context.accounts.subscriptions ?? []), homeConflict: null };
      const response = await handler(ctx, url);
      // The version of the snapshot the rows were read from.
      if (!response.headers.has(DATA_VERSION_HEADER)) response.headers.set(DATA_VERSION_HEADER, dataVersion(db,{capacityCycles: url.pathname === "/api/capacity-cycles",contextPrices:contextRequested(url) ? url.pathname : false}));
      return { status: response.status, headers: [...response.headers] as Array<[string, string]>, body: await response.text() };
    });
  } catch (error) {
    answer = { error: error instanceof Error ? error.message : String(error) };
  } finally { setTransactionContext(""); }
  worker.postMessage(answer);
};
