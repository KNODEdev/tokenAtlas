import { describe, expect, test } from "bun:test";
import { cloudProblemAction, cloudSessionProblems } from "./cloud-sessions";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";

// TALK-001 D9: incomplete cloud history names the next step for its actual cause (docs/claude-cloud.md).
describe("cloud history problems", () => {
  test("a missing trusted device asks to confirm the device", () => {
    expect(cloudProblemAction(["MAIN-cloud: session history needs a trusted device: run /login in this Claude Code profile to renew its device credential"]))
      .toBe("trusted-device");
  });
  test("an expired or rejected sign-in asks to sign in again", () => {
    expect(cloudProblemAction(["MAIN-cloud: [login-expired] Claude sign-in expired: refresh token rejected"])).toBe("sign-in");
    expect(cloudProblemAction(["Claude cloud sessions: HTTP 401 (unauthorized)"])).toBe("sign-in");
  });
  test("a network or server failure has no user action: the import retries", () => {
    expect(cloudProblemAction(["Claude cloud sessions: HTTP 503"])).toBeNull();
    expect(cloudProblemAction(["fetch failed"])).toBeNull();
  });
  test("cloud import turned off shows no problem at all", () => {
    const off = { setting: { minutes: 0, source: "settings" }, status: { running: false, nextRunAt: null, last: null, error: "HTTP 401" } } as unknown as CloudSessionsResponse;
    expect(cloudSessionProblems(off)).toEqual([]);
  });
});
