import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudSessionsHelpContent } from "./CloudSessionsHelp";
import { cloudSessionProblems } from "../lib/cloud-sessions";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";
import { statusLine } from "./StatusBar";
import { translateForLanguage } from "../lib/i18n";

const failed: CloudSessionsResponse = { setting: { minutes: 30, source: "default" }, status: {
  running: false, nextRunAt: null, error: null, last: { finishedAt: "2026-10-27T10:00:00Z", profiles: [
    { archiveDir: "C:/archive/claude/PC-profile-cloud", sessions: 4, changed: 0, published: 0, errors: ["missing trusted device"] },
  ] },
} };
const line = (state: CloudSessionsResponse | null, error: string | null = null) => statusLine({
  sync: { running: false } as never, syncUnavailable: false, rebuild: { job: null, unavailable: false },
  activity: { data: null, unavailable: false }, waitingForSubscriptions: false, staleAt: null,
  cloudSessions: state, cloudSessionsError: error,
  t: (en, pl, values) => translateForLanguage("en", en, pl, values),
});

test("import errors retain their profile and stop the global all-current claim", () => {
  expect(cloudSessionProblems(failed)).toEqual(["PC-profile-cloud: missing trusted device"]);
  expect(line(failed)).toMatchObject({ tone: "warn", title: "Claude cloud history incomplete" });
  const recovered = structuredClone(failed);
  recovered.status!.last!.profiles[0]!.errors = [];
  expect(line(recovered).title).toBe("Data up to date");
  expect(line(recovered, "HTTP 503")).toMatchObject({ tone: "warn", title: "Cloud import status unavailable" });
  expect(cloudSessionProblems({ ...failed, setting: { minutes: 0, source: "settings" } })).toEqual([]);
});

test("drawer explains recovery and missing coverage without claiming missing usage is zero", () => {
  const html = renderToStaticMarkup(<CloudSessionsHelpContent problems={cloudSessionProblems(failed)} />);
  for (const text of ["/login", "trusted-device", "PC-profile-cloud", "Missing history is not zero usage", "modelUsage", "docs/claude-cloud.md"])
    expect(html).toContain(text);
});
