/** Conservative payload budget: JS strings may use two bytes per code unit. */
export const RESPONSE_MEMORY_BYTES = 32 * 1024 * 1024;
export const stringMemoryBytes = (value: string): number => 2 * value.length;

interface Retained { bytes: number; evict(): void }

/** One LRU budget for disposable replies belonging to one server context. */
export class ResponseMemoryBudget {
  private retained = new Map<object, Retained>();
  private bytes = 0;
  constructor(readonly limit = RESPONSE_MEMORY_BYTES) {}
  retain(token: object, bytes: number, evict: () => void): void {
    this.release(token);
    this.retained.set(token, { bytes, evict });
    this.bytes += bytes;
    while (this.bytes > this.limit) {
      const oldest = this.retained.entries().next().value;
      if (!oldest) break;
      this.release(oldest[0]); oldest[1].evict();
    }
  }
  touch(token: object): void {
    const item = this.retained.get(token);
    if (item) { this.retained.delete(token); this.retained.set(token, item); }
  }
  release(token: object): void {
    const item = this.retained.get(token);
    if (item) { this.bytes -= item.bytes; this.retained.delete(token); }
  }
  stats() { return { bytes: this.bytes, entries: this.retained.size, limit: this.limit }; }
}

/** Each cache keeps its entry bound while sharing payload space with its peers. */
export class ResponseMemoryCache<T> {
  private values = new Map<string, { value: T }>();
  constructor(private budget: ResponseMemoryBudget, private measure: (value: T) => number, private maxEntries = 256) {}
  get size() { return this.values.size; }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key); this.values.set(key, entry); this.budget.touch(entry);
    return entry.value;
  }
  remember(key: string, value: T): void {
    const previous = this.values.get(key);
    if (previous?.value === value) { this.get(key); return; }
    this.delete(key);
    const bytes = stringMemoryBytes(key) + this.measure(value);
    // An oversized reply is delivered to its caller without evicting useful replies.
    if (bytes > this.budget.limit) return;
    const entry = { value };
    this.values.set(key, entry);
    this.budget.retain(entry, bytes, () => this.values.delete(key));
    while (this.values.size > this.maxEntries) this.delete(this.values.keys().next().value!);
  }
  delete(key: string): void {
    const entry = this.values.get(key);
    if (entry) { this.budget.release(entry); this.values.delete(key); }
  }
  clear(): void { for (const key of this.values.keys()) this.delete(key); }
  *entries(): IterableIterator<[string, T]> { for (const [key, entry] of this.values) yield [key, entry.value]; }
}
