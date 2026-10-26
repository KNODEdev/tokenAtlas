import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/sqlite";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { CONFIG_ROOT } from "../config/paths";
import type { WindowEndCause } from "../db/window-end-causes";
import {
  isCorrectable, overrideCauses, overrideKey,
  type AccountWindowEnd, type AccountWindowEnds, type WindowEndOverride, type WindowEndOverrideInput, type WindowEndOverrideStore,
} from "../shared/window-end-overrides";
import { countersOf, mainCountersOf } from "./main-counter";

/**
 * The person's corrections of window end causes: one JSON declaration beside the other manual entries in the
 * configuration folder (archived with them). The background step (window-end-causes.ts) applies them and queues only
 * the windows whose correction changed.
 */
export const WINDOW_END_OVERRIDES_FILE = "window-end-overrides.json";
const EMPTY: WindowEndOverrideStore = { revision: "empty", overrides: [] };
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ACCOUNT = /^[a-z0-9][a-z0-9_.@+:-]{0,199}$/;

function validOverride(value: unknown): value is WindowEndOverride {
  if (!value || typeof value !== "object") return false;
  const o = value as WindowEndOverride;
  return typeof o.provider === "string" && typeof o.account === "string" && ACCOUNT.test(o.account) && typeof o.counter === "string"
    && o.counter.length > 0 && o.counter.length <= 200 && iso(o.window_start) && iso(o.updated_at)
    && (overrideCauses(o.provider) as string[]).includes(o.cause);
}

export function readWindowEndOverrides(root = CONFIG_ROOT): WindowEndOverrideStore {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(root, WINDOW_END_OVERRIDES_FILE), "utf8")) as WindowEndOverrideStore;
    if (typeof store.revision !== "string" || !Array.isArray(store.overrides) || !store.overrides.every(validOverride))
      throw new Error("Nieprawidłowy plik korekt końców okien");
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
}

// The background step asks every turn (once a second when idle): the file is parsed again only when it changed.
let cached: { root: string; stamp: string; store: WindowEndOverrideStore } | null = null;
/** The current corrections, or null when the file cannot be read (the step then keeps what it applied). */
export function currentWindowEndOverrides(root = CONFIG_ROOT): WindowEndOverride[] | null {
  let stamp: string;
  try {
    const stat = fs.statSync(path.join(root, WINDOW_END_OVERRIDES_FILE));
    stamp = `${stat.mtimeMs}|${stat.size}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  if (cached?.root === root && cached.stamp === stamp) return cached.store.overrides;
  try {
    const store = readWindowEndOverrides(root);
    cached = { root, stamp, store };
    return store.overrides;
  } catch { return null; }
}

interface CauseRow { account: string; counter: string; window_start: string; window_end: string; planned_reset: string; cause: WindowEndCause; evidence: string }
const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** The main-counter windows of an account's ids (Settings passes every id the account was seen under), newest first. */
export function accountWindowEnds(db: Database, provider: string, accounts: readonly string[], store: WindowEndOverrideStore): AccountWindowEnds {
  const windows: AccountWindowEnd[] = [];
  const chosen = new Map(store.overrides.filter((o) => o.provider === provider).map((o) => [overrideKey(o), o.cause]));
  if (!tableExists(db, "window_end_causes") || !tableExists(db, "limit_windows")) return { revision: store.revision, windows, pending: false };
  for (const account of accounts) {
    for (const main of mainCountersOf(countersOf(db, provider, account))) {
      const rows = db.query(`SELECT account, counter, window_start, window_end, planned_reset, cause, evidence FROM window_end_causes
        WHERE provider=? AND account=? AND counter=?`).all(provider, account, main.id) as CauseRow[];
      for (const row of rows) {
        let auto = row.cause;
        try { auto = (JSON.parse(row.evidence) as { manual?: { auto?: WindowEndCause } }).manual?.auto ?? row.cause; } catch { /* Plain evidence. */ }
        windows.push({ account: row.account, counter: row.counter, window_start: row.window_start, window_end: row.window_end, planned_reset: row.planned_reset,
          cause: row.cause, auto, override: chosen.get(overrideKey({ provider, ...row })) ?? null });
      }
    }
  }
  windows.sort((a, b) => b.window_start.localeCompare(a.window_start));
  // A correction not yet applied, or one removed but still stored: the step catches up within a turn.
  const pending = windows.some((w) => isCorrectable(w.auto) && (w.override ?? w.auto) !== w.cause);
  return { revision: store.revision, windows, pending };
}

/** GET lists an account's windows; POST sets (cause) or removes (cause null) one correction against the read revision. */
export async function handleWindowEndOverrides(req: Request, db: Database, root = CONFIG_ROOT): Promise<Response> {
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!["GET", "POST"].includes(req.method)) return response({ error: "Method not allowed" }, 405);
  const params = new URL(req.url).searchParams;
  const provider = (params.get("provider") ?? "").toLowerCase();
  const accounts = [...new Set(params.getAll("account").map((account) => account.toLowerCase()))];
  if (!/^[a-z0-9_-]{1,40}$/.test(provider) || !accounts.length || accounts.length > 50 || !accounts.every((account) => ACCOUNT.test(account)))
    return response({ error: "Wybierz dostawcę i konto" }, 400);
  try {
    let store = readWindowEndOverrides(root);
    if (req.method === "POST") {
      let body: WindowEndOverrideInput;
      try { body = await req.json() as WindowEndOverrideInput; } catch { return response({ error: "Oczekiwano JSON" }, 400); }
      store = readWindowEndOverrides(root);
      const account = typeof body?.account === "string" ? body.account.toLowerCase() : "";
      if (!body || typeof body.revision !== "string" || !accounts.includes(account) || typeof body.counter !== "string" || !iso(body.window_start)
        || (body.cause !== null && !(overrideCauses(provider) as string[]).includes(body.cause)))
        return response({ error: "Nieprawidłowa korekta okna" }, 400);
      if (body.revision !== store.revision) return response({ error: "Korekty zmieniły się. Odśwież listę przed zapisem." }, 409);
      const target = accountWindowEnds(db, provider, [account], store).windows
        .find((w) => w.counter === body.counter && w.window_start === body.window_start);
      if (!target) return response({ error: "Nie znaleziono tego okna" }, 404);
      if (!isCorrectable(target.auto)) return response({ error: "Tego końca okna nie można poprawić: nie był wczesnym resetem" }, 409);
      const key = overrideKey({ provider, account, counter: body.counter, window_start: body.window_start });
      const overrides = store.overrides.filter((o) => overrideKey(o) !== key);
      // Choosing what the evidence already says stores nothing.
      if (body.cause !== null && body.cause !== target.auto)
        overrides.push({ provider, account, counter: body.counter, window_start: body.window_start, cause: body.cause, updated_at: new Date().toISOString() });
      if (overrides.length > 5000) return response({ error: "Osiągnięto limit 5000 korekt" }, 400);
      if (target.override === (body.cause === target.auto ? null : body.cause))
        return response(accountWindowEnds(db, provider, accounts, store));
      store = { revision: crypto.randomUUID(), overrides };
      atomicArchiveWrite(path.join(root, WINDOW_END_OVERRIDES_FILE), JSON.stringify(store, null, 2) + "\n");
    }
    return response(accountWindowEnds(db, provider, accounts, store));
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
