import { expect, test } from "bun:test";
import { ResponseMemoryBudget, ResponseMemoryCache, stringMemoryBytes } from "./response-memory";
import { ResponseCache } from "./cache";

test("HTTP and analytical replies share one budget and the oldest cold reply is evicted", () => {
  const memory = new ResponseMemoryBudget(100), http = new ResponseCache(undefined, memory);
  const analytical = new ResponseMemoryCache<string>(memory, stringMemoryBytes);
  http.set("http", "v", "x".repeat(15)); // 40 bytes
  analytical.remember("older", "y".repeat(15)); // 40 bytes
  expect(http.get("http", "v")).toBe("x".repeat(15));
  analytical.remember("newest", "z".repeat(15)); // 42 bytes
  expect(analytical.get("older")).toBeUndefined();
  expect(http.get("http", "v")).toBeTruthy();
  expect(analytical.get("newest")).toBeTruthy();
  expect(memory.stats()).toEqual({ bytes: 82, entries: 2, limit: 100 });
  http.invalidate();
  expect(memory.stats().bytes).toBe(42);
  analytical.clear(); expect(memory.stats().bytes).toBe(0);
});

test("replacement, entry limits and oversized Unicode replies preserve the shared accounting", () => {
  const memory = new ResponseMemoryBudget(100), cache = new ResponseMemoryCache<string>(memory, stringMemoryBytes, 2);
  cache.remember("a", "ą".repeat(10));
  cache.remember("a", "😀".repeat(10));
  expect(memory.stats().bytes).toBe(42);
  cache.remember("b", "b"); cache.remember("c", "c");
  expect(cache.get("a")).toBeUndefined();
  expect(memory.stats().bytes).toBe(8);
  cache.remember("oversized", "😀".repeat(100));
  expect(cache.get("oversized")).toBeUndefined();
  expect(cache.size).toBe(2);
  cache.delete("b"); cache.delete("b");
  expect(memory.stats().bytes).toBe(4);
});

test("warm hits and reuse of the same answer never measure its payload again", () => {
  const memory = new ResponseMemoryBudget(100); let measured = 0;
  const cache = new ResponseMemoryCache<{ body: string }>(memory, value => { measured++; return stringMemoryBytes(value.body); });
  const answer = { body: "cached" }; cache.remember("a", answer);
  for (let i = 0; i < 100; i++) { expect(cache.get("a")).toBe(answer); cache.remember("a", answer); }
  expect(measured).toBe(1);
});
