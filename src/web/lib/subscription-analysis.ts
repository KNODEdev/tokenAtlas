import { api } from "./api";
import { codexCounterMinutes } from "../../shared/codex-counters";
import type { SubscriptionAccountingOptions } from "../../shared/subscription-accounting";

/** UI capabilities and transport are isolated from common dates, views and measurements. */
export function subscriptionAnalysisAdapter(provider: string) {
  const id = ({ openai: "codex", anthropic: "claude", google: "gemini", xai: "grok", zai: "glm" } as Record<string, string>)[provider] ?? provider;
  return {
    id,
    readCapacity: ({ counter, ...scope }: SubscriptionAccountingOptions & { account: string }, signal?: AbortSignal) =>
      api.codexCapacity({ since: scope.since, until: scope.until, account: scope.account,
        ...(counter ? { window_minutes: requiredCodexMinutes(counter) } : {}) }, signal),
    read: ({ counter, ...scope }: SubscriptionAccountingOptions,signal?:AbortSignal) => id === "codex"
      ? api.codexAccounting({ ...scope, ...(counter ? { window_minutes: requiredCodexMinutes(counter) } : {}) },signal)
      : api.subscriptionAccounting({ ...scope, counter, provider: id },signal),
    markers: () => id === "codex" ? api.codexTimelineMarkers() : api.subscriptionTimelineMarkers(id),
  };
}

function requiredCodexMinutes(counter: string) {
  const minutes = codexCounterMinutes(counter);
  if (minutes === null) throw new Error("Invalid Codex counter");
  return minutes;
}
