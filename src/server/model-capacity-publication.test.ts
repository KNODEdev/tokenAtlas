import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AppContext } from './api';
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, TIMES } from './claude-code-capacity.fixture';
import { handleModelCapacity } from './model-capacity';
import { advanceWindowUsage, computeWindowUsageFull, emptyWindowUsageStats } from './window-usage';
import type { ModelCapacityResponse } from '../shared/model-capacity';

test('native Claude publication survives restart, a new reading and a corrected event without competing valuation', async () => {
  const f=createClaudeCodeAcceptanceFixture();
  const options={rateCards:f.rates,claudeGauge:{},cycles:{windows:[]},manualCapacity:()=>[]};
  const prices=()=>createHash('sha256').update(JSON.stringify(f.db.query(`SELECT identity,std_key,std_reason,std_usd,std_nano,std_femto
    FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all())).digest('hex');
  const read=async()=>await handleModelCapacity({sqlite:f.db,plans:{},plansCatalog:{provider_groups:[]}} as unknown as AppContext,
    new URL(`http://local/api/model-capacity?provider=claude&account=${ACCOUNTS.a}&since=2026-09-01&until=2026-09-30`)).json() as ModelCapacityResponse;
  try {
    f.db.query("UPDATE probe_windows SET used_percent=40,vendor_percent=40 WHERE subject=? AND used_percent=24").run(ACCOUNTS.a);
    f.prepareProbes();
    let value=await read();expect(value.preparing_windows).toBe(0);expect(value.rows[0]!.samples).toBe(1);
    expect(value.rows[0]!.tokens!.median).toBeGreaterThan(0);
    const beforePrices=prices(),before=JSON.stringify(value);
    f.reopen();expect(JSON.stringify(await read())).toBe(before);
    const idle=emptyWindowUsageStats();advanceWindowUsage(f.db,{...options,budgetMs:1e9,stats:idle});
    expect(idle.windows).toBe(0);expect(idle.events).toBe(0);
    f.db.query("UPDATE probe_windows SET used_percent=50,vendor_percent=50 WHERE subject=? AND used_percent=40").run(ACCOUNTS.a);
    f.prepareProbes();
    expect(prices()).toBe(beforePrices);
    value=await read();expect(value.rows[0]!.tokens!.median).toBeLessThan(JSON.parse(before).rows[0].tokens.median);
    const otherBefore=JSON.stringify(f.db.query("SELECT cycle FROM window_usage WHERE provider='claude' AND account=? ORDER BY window_id").all(ACCOUNTS.b));
    f.db.query("UPDATE claude_events SET in_uncached=in_uncached+1000 WHERE call_id='between'").run();
    f.prepareFacts();
    expect(JSON.stringify(f.db.query("SELECT cycle FROM window_usage WHERE provider='claude' AND account=? ORDER BY window_id").all(ACCOUNTS.b))).toBe(otherBefore);
    const full=computeWindowUsageFull(f.db,options);
    for(const row of f.db.query("SELECT provider,account,counter,window_id,cycle FROM window_usage WHERE provider='claude'").all() as any[])
      expect(JSON.parse(row.cycle).model_capacity).toEqual(full.get(JSON.stringify([row.provider,row.account,row.counter,row.window_id]))!.cycle.model_capacity);
  } finally {f.teardown();}
});
