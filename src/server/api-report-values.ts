

export interface UnpricedResult {
  tokens: number;
  models: Record<string, number>;
}

export class UnpricedCollector {
  private counts = new Map<string, number>();
  add(model: string | null | undefined, tokens: number) {
    if (!tokens) return;
    const key = model || "?";
    this.counts.set(key, (this.counts.get(key) || 0) + tokens);
  }
  toJSON(): UnpricedResult {
    let tokens = 0;
    const models: Record<string, number> = {};
    for (const [k, v] of this.counts.entries()) {
      models[k] = v;
      tokens += v;
    }
    return { tokens, models };
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const HOUR_MS = 3_600_000;
