/** OpenAI input includes both cache categories; reasoning is already in output. */
export function codexTokenCost(
  input: number, read: number, write: number, output: number,
  rates: { in_uncached: number; in_cache_read: number; in_cache_write?: number | null; out_total: number },
) {
  if (![input, read, write, output].every(n => Number.isSafeInteger(n) && n >= 0)
    || read + write > input || !Number.isSafeInteger(input + output)) return null;
  if (![rates.in_uncached, rates.in_cache_read, rates.out_total].every(n => Number.isFinite(n) && n >= 0)
    || (write > 0 && (rates.in_cache_write == null || !Number.isFinite(rates.in_cache_write) || rates.in_cache_write < 0))) return null;
  const parts = {
    input: (input - read - write) * rates.in_uncached / 1e6,
    cached: read * rates.in_cache_read / 1e6,
    cache_write: write === 0 ? 0 : write * rates.in_cache_write! / 1e6,
    output: output * rates.out_total / 1e6,
  };
  const total = ((input - read - write) * rates.in_uncached + read * rates.in_cache_read
    + (write === 0 ? 0 : write * rates.in_cache_write!) + output * rates.out_total) / 1e6;
  return Number.isFinite(total) ? { ...parts, total } : null;
}
