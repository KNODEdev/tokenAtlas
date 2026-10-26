import { expect, test } from "bun:test";
import { TIBO_PROMISES, TIBO_SPEED_CLAIM, tiboBounds, tiboDate, tiboDayStatus, tiboLocalDate, tiboPublicDay } from "./tibo-challenge";

test("public reset and delivery state follow the catalog independently of local accounts", () => {
  const now = Date.parse("2026-10-17T12:00Z");
  expect(tiboPublicDay(14, now).reset).toBe("future");
  expect(tiboPublicDay(14, Date.parse("2026-10-18T14:51:11Z")).state).toBe("pending");
  expect(tiboPublicDay(14, Date.parse("2026-10-18T14:51:11Z")).reset).toBe("unknown");
  expect(tiboPublicDay(1, now).reset).toBe("none");
  expect(tiboPublicDay(2, now).reset).toBe("full");
  expect(tiboPublicDay(3, now).reset).toBe("banked");
  expect(tiboPublicDay(6, now).state).toBe("released");
  expect(tiboPublicDay(13, Date.parse("2026-10-19T12:00Z")).reset).toBe("full");
  expect(tiboPublicDay(15, Date.parse("2026-10-20T12:00Z")).state).toBe("unconfirmed");
  expect(tiboPublicDay(2, Date.parse("2026-10-04T12:00Z")).promises).toHaveLength(0);
});

test("campaign dates and day states use Pacific midnight, including the final 25-hour DST day", () => {
  expect(tiboDate(1)).toBe("2026-10-05"); expect(tiboDate(28)).toBe("2026-11-01");
  expect(tiboBounds(1)).toEqual({ from: Date.parse("2026-10-05T07:00Z"), until: Date.parse("2026-10-06T07:00Z") });
  expect(tiboBounds(28).until - tiboBounds(28).from).toBe(25 * 3_600_000);
  expect(tiboLocalDate(Date.parse("2026-10-17T03:00Z"))).toBe("2026-10-16");
  expect(tiboDayStatus(14, Date.parse("2026-10-18T10:00Z"))).toBe("pending");
  expect(tiboDayStatus(15, Date.parse("2026-10-20T10:00Z"))).toBe("unconfirmed");
  expect(tiboDayStatus(14, Date.parse("2026-10-17T10:00Z"))).toBe("future");
  expect(tiboDayStatus(12, Date.parse("2026-10-17T10:00Z"))).toBe("recorded");
});

test("day one retains both the relative announcement and the sourced 30-to-50 TPS clarification", () => {
  const promises = TIBO_PROMISES.filter(p => p.day === 1);
  expect(promises.some(p => p.en.includes("+50%"))).toBe(true);
  expect(promises.find(p => p.source === TIBO_SPEED_CLAIM.source)?.en).toContain("30 → 50 tok/s");
  expect(TIBO_SPEED_CLAIM).toMatchObject({ before: 30, after: 50 });
});
