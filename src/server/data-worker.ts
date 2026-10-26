import type { AppContext } from "./app-context-types";
import { loadAccountResolver } from "./account-resolver";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { buildDataView, DATA_VIEWS, type DataContext, type DataEnvelope } from "./data-views";

import { restoreSubscriptionHomes } from "./capacity-equivalents";
import { Database, setTransactionContext } from "../db/sqlite";
import { withReadSnapshotAsync } from "../db/analysis";
import type { CyclesConfig } from "./cycles";
import { buildEraIndex, type EraDeclaration } from "./eras";
import type { RateCard } from "./pricing";
import type { PlansConfig } from "./plans";
import type { PlansCatalog } from "./plans-catalog";
import type { SubscriptionV2 } from "../config/accounts-v2";
import type { SourceDeclaration } from "./archive-source";
import { windowAnswerMarkSeq } from "../db/window-answers";
import { dataVersion } from "./data-version";
import { readsWindowSums } from "./data-views";
import { contextRequested } from "./codex-context-preview";
import { WINDOW_SCREENS } from "./window-screens";
import { PREPARED_AT_HEADER } from "./data-clock";

/** One answer of the exception list (data-read.ts) the worker computes from the current rows. */
export type AnalysisRequest = { kind: "view"; url: string }
  /** A window screen (window-screens.ts): built by its producer for the stored answers. */
  | { kind: "screen"; url: string };
export type AnalysisReport = DataEnvelope;

export interface DataWork {
  dbPath: string;
  context?: DataContext;
  rates: RateCard;
  request: AnalysisRequest;
  homes: Array<[string, string]>;
  sourceHomes?: string[];
  eras?: EraDeclaration[];
  subscriptions?: SubscriptionV2[];
  sources?: SourceDeclaration[];
  plans?: PlansConfig;
  catalog?: PlansCatalog;
  cycles?: CyclesConfig;
}

/** The request as a long-transaction warning names it. */
function describeRequest(request: AnalysisRequest): string {
  const text = request.url;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** A window screen's answer as an envelope, with the instant it was built for clock presentation. */
async function buildWindowScreen(ctx: AppContext, url: URL): Promise<DataEnvelope> {
  const screen = WINDOW_SCREENS[url.pathname];
  if (!screen) throw new Error(`Not a window screen: ${url.pathname}`);
  const builtAt = Date.now(), response = await screen.produce(ctx, url);
  return { status: response.status, body: await response.json(),
    headers: [...[...response.headers].filter(([name]) => name.toLowerCase() !== PREPARED_AT_HEADER.toLowerCase()),
      [PREPARED_AT_HEADER, new Date(builtAt).toISOString()]] as Array<[string, string]> };
}

/** What the worker read an answer from: the newest window-answer mark and the rows' version, in its snapshot. */
export interface AnalysisSnapshot { checked: number; version: string }

const worker = self as unknown as Worker;
// The connection stays open between answers so its page cache and prepared statements are reused; every
// answer still reads in a new snapshot, so it sees everything published before it.
let open: { path: string; db: Database } | null = null;
const connection = (dbPath: string) => {
  if (open?.path === dbPath) return open.db;
  open?.db.close();
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA busy_timeout=3000; PRAGMA cache_size=-32768; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
  open = { path: dbPath, db };
  return db;
};
worker.onmessage = async (message: MessageEvent<DataWork | { close: true }>) => {
  if ("close" in message.data) { open?.db.close(); open = null; worker.postMessage({ closed: true }); return; }
  let db: Database | undefined;
  let response: { report: AnalysisReport; snapshot?: AnalysisSnapshot } | { error: string; pending?: boolean };
  try {
    const work = message.data;
    setTransactionContext(describeRequest(work.request));
    // An answer is computed from the rows the background producers published; it writes nothing.
    db = connection(work.dbPath);
    const eras = work.eras ? buildEraIndex(work.eras, "instant") : undefined;
    const subscriptions = work.context?.accounts.subscriptions ?? work.subscriptions ?? [];
    const sources = work.context?.accounts.sources ?? work.sources ?? [];
    const homes = restoreSubscriptionHomes(work.homes, work.sourceHomes ?? [], sources);
    const resolver = loadAccountResolver(db, subscriptions);
    const request = work.request;
    if (!work.context) throw new Error("Data context is required");
    const { subHomes, ...context } = work.context;
    const ctx: AppContext = { ...context, sqlite: db, dbPath: work.dbPath, rateCards: work.rates,
      homeToSubId: homes, subIdToHomes: new Map(subHomes), eras: eras!, resolver, homeConflict: null };
    // One snapshot of the stored rows for the whole view, and of what it says about them.
    const url = new URL(request.url, "http://local"), read = db;
    const build = request.kind === "view" ? () => buildDataView(ctx, url) : () => buildWindowScreen(ctx, url);
    response = await withReadSnapshotAsync(read, async () => ({ snapshot: { checked: windowAnswerMarkSeq(read),
      version: dataVersion(read, { windowSums: readsWindowSums(url.pathname), capacityCycles: DATA_VIEWS[url.pathname]?.sources.includes("capacity_cycle_results") ?? false,
        firstTokenTimes: DATA_VIEWS[url.pathname]?.sources.includes("response_time_hours") ?? false,
        contextPrices: contextRequested(url) ? url.pathname : false }) }, report: await build() }));
  } catch (error) {
    // A register that is still being prepared is a preparation state, not a failure. The class cannot
    // cross the worker boundary, so it travels as an explicit flag.
    response = { error: error instanceof Error ? error.message : String(error),
      ...(error instanceof SubscriptionFactsPending || error instanceof ProbeAccountIndexUnavailable || error instanceof CodexLedgerNotReady
        ? { pending: true } : {}) };
  } finally { setTransactionContext(""); }
  worker.postMessage(response);
};
