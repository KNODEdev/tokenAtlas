/** Execution settings are independent dimensions; an absent effort is never a guessed level. */
export interface ModelExecution { speed: string; effort: string | null }
export const recordedEffort = (value: unknown): string | null =>
  typeof value === "string" && value.trim() && value !== "?" ? value.trim() : null;
export function codexExecution(tier: string | null, effort: unknown,
  classify?: (tier: string | null) => string | null): ModelExecution {
  const speed = classify ? classify(tier) : tier == null || tier === "default" ? "standard" : tier === "priority" ? "fast" : null;
  return { speed: speed ?? `unknown:${tier ?? ""}`, effort: recordedEffort(effort) };
}
export const executionKey = (model: string | null, execution: Partial<ModelExecution>): string =>
  JSON.stringify([model, execution.speed ?? "unknown", recordedEffort(execution.effort)]);
