/**
 * The account cards (`/api/roster`) while stored rows are being prepared. The roster is built in a direct-read
 * worker on every cache miss; an account whose window sums or probe index are not ready marks itself in
 * `preparing_accounts` instead of turning the whole roster into a preparation receipt. This keeper, on the HTTP
 * thread, remembers the last ready card of every account and answers with it, marked stale, while the account
 * is preparing; a roster that is preparing as a whole gets the last ready roster. Nothing is persisted: a
 * restart starts empty, and the first answers then show the other accounts with the preparing ones empty.
 */

/** An account of a roster answer that is still being prepared; `id` null: the vendor's cards as a whole (GLM). */
export interface RosterPreparingAccount { vendor: string; id: string | null }

interface RosterAccountRow { id?: unknown; vendor?: unknown; preparing?: unknown; [field: string]: unknown }
interface RosterBody { accounts?: RosterAccountRow[]; count?: number; preparing_accounts?: RosterPreparingAccount[]; [field: string]: unknown }
interface ReadyCard { row: RosterAccountRow; builtAt: number }
/** The last roster answered for one request: `preparedAt` is the build time of its oldest card. */
interface ReadyRoster { database: string; body: RosterBody; preparedAt: number; cards: Map<string, ReadyCard> }

/** Window lengths a page asks for; each keeps one last ready roster. */
const MAX_ROSTERS = 8;
const accountKey = (vendor: unknown, id: unknown) => `${String(vendor ?? "").toLowerCase()}\u0000${String(id ?? "").toLowerCase()}`;

function staleResponse(body: RosterBody, preparedAt: number, headers: Headers): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json");
  out.set("X-Analysis", "stale");
  out.set("X-Analysis-Prepared-At", String(preparedAt));
  out.set("Cache-Control", "no-store");
  out.delete("Content-Length");
  return new Response(JSON.stringify(body), { status: 200, headers: out });
}

export function createRosterFallback(now: () => number = Date.now) {
  const rosters = new Map<string, ReadyRoster>();
  const remember = (key: string, roster: ReadyRoster) => {
    rosters.delete(key); rosters.set(key, roster);
    if (rosters.size > MAX_ROSTERS) rosters.delete(rosters.keys().next().value!);
  };
  /**
   * The answer of one roster request: `response` as the worker built it. `database` identifies the database it
   * was read from, so a database switch never shows another database's cards.
   */
  async function respond(key: string, database: string, response: Response): Promise<Response> {
    const last = rosters.get(key);
    const known = last?.database === database ? last : undefined;
    if (response.status === 202 && response.headers.get("X-Analysis") === "preparing") {
      if (!known) return response;
      await response.body?.cancel();
      return staleResponse(known.body, known.preparedAt, response.headers);
    }
    if (response.status !== 200) return response;
    const text = await response.text();
    let body: RosterBody;
    try { body = JSON.parse(text) as RosterBody; }
    catch { return new Response(text, { status: response.status, headers: response.headers }); }
    if (!Array.isArray(body.accounts)) return new Response(text, { status: response.status, headers: response.headers });
    const builtAt = now();
    const pending = body.preparing_accounts ?? [];
    const cards = new Map(known?.cards ?? []);
    for (const row of body.accounts) if (row && row.preparing !== true) cards.set(accountKey(row.vendor, row.id), { row, builtAt });
    if (!pending.length) {
      remember(key, { database, body, preparedAt: builtAt, cards });
      return new Response(text, { status: response.status, headers: response.headers });
    }
    // Each preparing account shows its last ready card; one never seen ready stays as the worker left it.
    let preparedAt = builtAt;
    const accounts = body.accounts.map(row => {
      if (!row || row.preparing !== true) return row;
      // Current committed meters must survive preparation and a reset. An old ready
      // card can contain another window's spend, so do not merge its aggregates here.
      if (row.claude_meters !== undefined) return row;
      const ready = cards.get(accountKey(row.vendor, row.id));
      if (!ready) return row;
      preparedAt = Math.min(preparedAt, ready.builtAt);
      return ready.row;
    });
    const present = new Set(accounts.map(row => accountKey(row?.vendor, row?.id)));
    // A vendor preparing as a whole (no id) has no row in the answer: its last ready rows are added back.
    for (const entry of pending) if (entry.id == null) {
      for (const [cardKey, ready] of cards) if (!present.has(cardKey) && String(ready.row.vendor ?? "").toLowerCase() === entry.vendor.toLowerCase()) {
        accounts.push(ready.row); present.add(cardKey);
        preparedAt = Math.min(preparedAt, ready.builtAt);
      }
    }
    const merged: RosterBody = { ...body, accounts, count: accounts.length };
    delete merged.preparing_accounts;
    remember(key, { database, body: merged, preparedAt, cards });
    return staleResponse(merged, preparedAt, response.headers);
  }
  return { respond };
}
