import assert from "node:assert/strict";
import type { AppContext } from "../../src/server/api";
import { codexAccountSelector } from "../../src/server/codex-source-account";
import { codexEventOwnedBy } from "../../src/server/codex-event-owner";
import { rational,decimal,add,multiply } from "../../src/db/price-ledger-exact";

export function assertCycleBreakdownParity(ctx:AppContext,defaults:{since:string;until:string},suffix:string,actual:{status:number;body:any},expected:{status:number;body:any}) {
  const compatible = structuredClone(actual) as {status:number;body:any};
  if (actual.status === 200) {
    assert.equal(compatible.body.credit_equivalent.basis,"dated-standard-reference");
    delete compatible.body.credit_equivalent;
    // The retired implementation priced no credits; per-bucket credits are checked against the call-by-call reference in
    // codex-window-detail-sums.test.ts, as the window's credit equivalent is.
    for (const bucket of [...compatible.body.days,...compatible.body.sessions]) { delete bucket.usd_partial; delete bucket.credits; delete bucket.credits_partial; }
    // The retired implementation counted the same unknown tokens in both its day and session passes.
    expected.body.unpriced.tokens /= 2;
    for (const model of Object.keys(expected.body.unpriced.models)) expected.body.unpriced.models[model] /= 2;
    expected.body.totals.usd = referenceWholeUsd(ctx,suffix,defaults);
  }
  assert.deepEqual(compatible,expected);
}

/** Independent raw-fixture oracle: sum declared exact prices before rounding the whole response. */
function referenceWholeUsd(ctx:AppContext,suffix:string,defaults:{since:string;until:string}):number {
  const params=new URLSearchParams(suffix.replace(/^&/,"")),from=params.get("since_ts") || defaults.since,until=params.get("until_ts") || defaults.until;
  const account=params.get("account") || "a",project=params.get("project_id");
  const owned=codexEventOwnedBy(ctx.sqlite,codexAccountSelector(ctx,"events"),account,{within:{from,until:new Date(Date.parse(until)+1).toISOString()}});
  let amount=rational(0n);
  const rows=ctx.sqlite.query(`SELECT * FROM events WHERE ts>=? AND ts<=? AND ${owned.sql}
    ${project ? project === "unassigned" ? "AND project_id IS NULL" : "AND project_id=?" : ""}`)
    .all(from,until,...owned.params,...(project && project!=="unassigned" ? [project] : [])) as Array<Record<string,any>>;
  for (const row of rows) {
    if (![row.in_tok,row.cached_in,row.cache_write,row.out_tok].every(value=>Number.isSafeInteger(value) && value>=0)
      || row.cached_in+row.cache_write>row.in_tok || !Number.isFinite(Date.parse(row.ts)) || ["invalid","incomplete","unknown"].includes(row.usage_status)) continue;
    const rule=ctx.rateCards.codex_accounting?.rules.find(rule=>rule.model===row.model && rule.speed==="standard" && rule.billing_basis==="api_equivalent_usd"
      && rule.valid_from<=row.ts.slice(0,10) && (!rule.valid_until || rule.valid_until>row.ts.slice(0,10)));
    if (!rule) continue;
    const rates=rule.long_context && row.in_tok>rule.long_context.above_input_tokens ? rule.long_context.rates : rule.rates;
    if (row.cache_write && rates.in_cache_write==null) continue;
    for (const [count,rate] of [[row.in_tok-row.cached_in-row.cache_write,rates.in_uncached],[row.cached_in,rates.in_cache_read],
      [row.cache_write,rates.in_cache_write ?? 0],[row.out_tok,rates.out_total]] as const) amount=add(amount,multiply(rational(BigInt(count),1000000n),decimal(rate)));
  }
  const scaled=amount.n*100n,whole=scaled/amount.d,remainder=scaled%amount.d;
  return Number(whole+(remainder*2n>=amount.d ? 1n : 0n))/100;
}

