import { PROVIDER_RESETS, type ProviderReset } from "./provider-resets";

// Completed global resets checked against the preserved public evidence:
// https://codex-resets.com/ and https://codex-reset.com/timeline (2026-10-20).
// Completion annotations are presentation evidence, independent of window-end classification.
const completedCodexIds = new Set([
  "codex-2026-10-11T04:01-reset",
  "codex-2026-10-07T03:35-reset",
  "codex-2026-10-02T21:18-reset",
  "codex-2026-09-26T18:17-reset",
  "codex-2026-09-12T08:09-reset",
  "codex-2026-09-08T01:56-reset",
  "codex-2026-08-31T02:29-reset",
  "codex-2026-08-27T16:35-reset",
  "codex-2026-08-25T14:30-reset",
  "codex-2026-08-24T00:46-reset",
  "codex-2026-08-11T00:27-reset",
  "codex-2026-08-08T20:29-reset",
  "codex-2026-08-01T03:32-reset",
  "codex-2026-07-29T04:09-reset",
  "codex-2026-07-28T03:09-reset",
  "codex-2026-07-25T19:17-reset",
  "codex-2026-07-18T03:28-reset",
  "codex-2026-07-10T17:59-reset",
  "codex-2026-06-28T23:54-reset",
  "codex-2026-06-18T00:10-reset",
  "codex-2026-06-04T00:25-reset",
  "codex-2026-05-31T15:25-reset",
  "codex-2026-05-23T20:14-reset",
  "codex-2026-05-16T17:51-reset",
  "codex-2026-04-28T05:28-reset",
  "codex-2026-03-27T01:52-reset",
  "codex-2026-03-08T02:42-reset",
]);

/** Public completion posts; their timestamps do not establish receipt by an individual account. */
export const COMPLETED_PROVIDER_RESETS: readonly ProviderReset[] = [
  ...PROVIDER_RESETS.filter(reset => reset.provider === "codex" && reset.kind === "reset" && !reset.approximate
    && completedCodexIds.has(reset.id)),
  ...[
    ["2026-10-13T05:06:06.031Z", "2109873287853707513"],
    ["2026-10-15T06:28:13.924Z", "2110618732666257557"],
    ["2026-10-17T21:12:21.411Z", "2111566005684289735"],
    ["2026-10-20T06:33:48.848Z", "2112432076767289678"],
    ["2026-10-25T06:06:16.000Z", "2114237083652882932"],
    ["2026-10-28T06:29:38.000Z", "2115330127886463244"],
  ].map(([at, post]) => ({
    id: `codex-${post}-completed`, provider: "codex" as const, at: at!, kind: "reset" as const, approximate: false,
    source: `https://x.com/thsottiaux/status/${post} https://codex-resets.com/`,
  })),
  // Without an X completion post the public tracker's record is the completion time (checked 2026-10-29).
  ...[
    ["2026-10-22T17:09:00.000Z", "1792688940000"],
    ["2026-10-23T17:41:26.000Z", "1792777286000"],
    ["2026-10-26T06:10:00.000Z", "1792995000000"],
  ].map(([at, page]) => ({
    id: `codex-tracker-${page}-completed`, provider: "codex" as const, at: at!, kind: "reset" as const, approximate: false,
    source: `https://didcodexreset.com/history/${page}.html https://codex-resets.com/`,
  })),
];
