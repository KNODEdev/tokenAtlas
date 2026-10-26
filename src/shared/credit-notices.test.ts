import { describe, expect, test } from "bun:test";
import { creditNoticeOccurredAt, expiryNotices, grantOutlook, poolChangeNotices, type NoticePool, type NoticePoolItem, type StoredPool } from "./credit-notices";

const DAY = 86_400_000;
const at = (day: number) => new Date(Date.UTC(2026, 9, 1) + day * DAY).toISOString();

const grant = (used: number, expires = at(35), granted = 250): NoticePool => ({ key: "claude:iguana_necktie", kind: "grant",
  unit: "usd", granted, used, remaining: granted - used, remaining_text: null, unlimited: false, granted_at: null,
  expires_at: expires, items: null });
const balance = (text: string): NoticePool => ({ key: "codex:credits", kind: "balance", unit: "credits", granted: null,
  used: null, remaining: Number(text), remaining_text: text, unlimited: false, granted_at: null, expires_at: null, items: null });
const reset = (id: string, granted: number, expires: number): NoticePoolItem =>
  ({ id, status: "available", granted_at: at(granted), expires_at: at(expires), title: "Full reset" });
const resets = (...items: NoticePoolItem[]): NoticePool => ({ key: "codex:resets", kind: "resets", unit: "resets",
  granted: null, used: null, remaining: items.length, remaining_text: null, unlimited: false, granted_at: null,
  expires_at: items.map(item => item.expires_at!).sort()[0] ?? null, items });
const kinds = (drafts: ReturnType<typeof poolChangeNotices>) => drafts.map(draft => `${draft.kind}:${draft.notice}:${draft.amount_text ?? draft.amount}`);

test("notice chronology uses grant and expiry facts, warning creation, and observation when no event date is known", () => {
  const base = { observed_at: at(25), expires_at: at(22), detail: { granted_at: "2026-09-29T20:39:37+02:00" } };
  expect(creditNoticeOccurredAt({ ...base, kind: "received" })).toBe("2026-09-29T18:39:37.000Z");
  expect(creditNoticeOccurredAt({ ...base, kind: "expired_unused" })).toBe(at(22));
  expect(creditNoticeOccurredAt({ ...base, kind: "expiring", created_at: at(26) })).toBe(at(26));
  for (const kind of ["used", "spent", "topped_up"] as const)
    expect(creditNoticeOccurredAt({ ...base, kind })).toBe(at(25));
  expect(creditNoticeOccurredAt({ ...base, kind: "received", detail: { granted_at: "invalid" } })).toBe(at(25));
  expect(creditNoticeOccurredAt({ ...base, kind: "expired_unused", expires_at: null })).toBe(at(25));
});

describe("pool change notices", () => {
  test("a first reading is the baseline except free resets granted within a week", () => {
    const drafts = poolChangeNotices(null, { read_at: at(10), pools: [grant(0), balance("60749.9557035"),
      resets(reset("old", 0, 30), reset("new", 8, 38))] });
    expect(kinds(drafts)).toEqual(["received:codex:resets|received|new:1"]);
  });

  test("free resets: a new id is received, one gone before its expiry was used, one gone after it was lost", () => {
    const before = { read_at: at(10), pools: [resets(reset("a", 0, 30), reset("b", 5, 12))] };
    const after = { read_at: at(13), pools: [resets(reset("c", 13, 43))] };
    expect(kinds(poolChangeNotices(before, after))).toEqual([
      "received:codex:resets|received|c:1", "used:codex:resets|used|a:1", "expired_unused:codex:resets|expired_unused|b:1"]);
  });

  test("a Codex balance moves exactly in the vendor's decimal text", () => {
    const first = { read_at: at(1), pools: [balance("60749.9557035")] };
    expect(kinds(poolChangeNotices(first, { read_at: at(2), pools: [balance("60700.1")] })))
      .toEqual(["spent:codex:credits|spent|:49.8557035"]);
    expect(kinds(poolChangeNotices(first, { read_at: at(2), pools: [balance("70749.9557035")] })))
      .toEqual([`topped_up:codex:credits|topped_up|${at(2)}:10000`]);
    expect(poolChangeNotices(first, { read_at: at(2), pools: [balance("60749.9557035000")] })).toEqual([]);
  });

  test("a Claude grant: received when new, spent as its use grows, lost when it expired with money left", () => {
    const empty = { read_at: at(1), pools: [] };
    const received = poolChangeNotices(empty, { read_at: at(2), pools: [grant(0)] });
    expect(kinds(received)).toEqual([`received:claude:iguana_necktie@${at(35)}|received|:250`]);
    expect(received[0]!.expires_at).toBe(at(35));
    expect(kinds(poolChangeNotices({ read_at: at(2), pools: [grant(0)] }, { read_at: at(3), pools: [grant(12.5)] })))
      .toEqual([`spent:claude:iguana_necktie@${at(35)}|spent|:12.5`]);
    const lost = poolChangeNotices({ read_at: at(34), pools: [grant(200)] }, { read_at: at(36), pools: [] });
    expect(kinds(lost)).toEqual([`expired_unused:claude:iguana_necktie@${at(35)}|expired_unused|:50`]);
    expect(lost[0]!.detail).toMatchObject({ upper_bound: true, last_seen: at(34) });
    // Still reported after its expiry: what it states as left was lost.
    expect(kinds(poolChangeNotices({ read_at: at(34), pools: [grant(200)] }, { read_at: at(36), pools: [grant(210)] })))
      .toEqual([`spent:claude:iguana_necktie@${at(35)}|spent|:10`, `expired_unused:claude:iguana_necktie@${at(35)}|expired_unused|:40`]);
    // Gone before its expiry: used up or withdrawn, no notice.
    expect(poolChangeNotices({ read_at: at(20), pools: [grant(200)] }, { read_at: at(21), pools: [] })).toEqual([]);
  });

  test("the same meter with a new expiry is a new grant", () => {
    const drafts = poolChangeNotices({ read_at: at(20), pools: [grant(250)] }, { read_at: at(21), pools: [grant(0, at(60))] });
    expect(kinds(drafts)).toEqual([`received:claude:iguana_necktie@${at(60)}|received|:250`]);
  });

  test("a top-up of a grant is its own notice", () => {
    expect(kinds(poolChangeNotices({ read_at: at(2), pools: [grant(10)] }, { read_at: at(3), pools: [grant(10, at(35), 300)] })))
      .toEqual([`topped_up:claude:iguana_necktie@${at(35)}|topped_up|${at(3)}:50`]);
  });
});

describe("expiry warnings", () => {
  const stored = (pool: NoticePool, read: number, baselineAt: number, baselineUsed: number | null): StoredPool =>
    ({ identity: pool.kind === "grant" ? `${pool.key}@${pool.expires_at}` : pool.key, pool, read_at: at(read),
      baseline_at: at(baselineAt), baseline_used: baselineUsed });

  test("pace since the first observation projects the unused part at expiry", () => {
    // $50 used over 10 days: $5 a day; $200 left and 10 days to go leaves $150.
    const outlook = grantOutlook(stored(grant(50, at(30)), 20, 10, 0), Date.parse(at(20)))!;
    expect(outlook.pace_per_day).toBeCloseTo(5, 9);
    expect(outlook.projected_unused).toBeCloseTo(150, 9);
    const [warning] = expiryNotices([stored(grant(50, at(30)), 20, 10, 0)], Date.parse(at(20)));
    expect(warning).toMatchObject({ kind: "expiring", notice: `claude:iguana_necktie@${at(30)}|expiring|14d` });
    expect(warning!.amount).toBeCloseTo(150, 9);
    expect(expiryNotices([stored(grant(50, at(30)), 20, 10, 0)], Date.parse(at(28)))[0]!.notice).toEndWith("|expiring|3d");
  });

  test("without a day of observation the whole remainder is at risk", () => {
    const outlook = grantOutlook(stored(grant(50, at(30)), 20, 19.5, 40), Date.parse(at(20)))!;
    expect(outlook.pace_per_day).toBeNull();
    expect(outlook.projected_unused).toBe(200);
  });

  test("no warning far from expiry, at a pace that uses the grant, or after expiry", () => {
    expect(expiryNotices([stored(grant(50, at(60)), 20, 10, 0)], Date.parse(at(20)))).toEqual([]);
    // $24 a day uses the $200 left within the 10 days.
    expect(expiryNotices([stored(grant(50, at(30)), 20, 18, 2)], Date.parse(at(20)))).toEqual([]);
    expect(expiryNotices([stored(grant(50, at(30)), 20, 10, 0)], Date.parse(at(31)))).toEqual([]);
  });

  test("a free reset warns in its last three days", () => {
    const pool = resets(reset("a", 0, 30), reset("b", 0, 40));
    expect(expiryNotices([stored(pool, 26, 0, null)], Date.parse(at(28))).map(draft => draft.notice))
      .toEqual(["codex:resets|expiring|a"]);
  });
});
