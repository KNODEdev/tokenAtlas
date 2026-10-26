import { afterEach, expect, test, spyOn } from "bun:test";
import { IdentityMask, setPrivacyEnabled, privateText, learnPrivacyIdentities, reportImageFileName } from "./privacy";
import { api } from "./api";

afterEach(() => setPrivacyEnabled(false));

test("masks identities, emails, paths and UUIDs without changing amounts, dates, models or provider names", () => {
  const mask = new IdentityMask();
  const raw = { subscriptions: [{ id: "codex-private", vendor: "codex", login: "Alice", machine: "PRIVATE-PC", vendor_account: "alice@example.test" }],
    projects: [{ id: "secret-repo", name: "Client [A]+", matches: [] }, { id: "tokenAtlas", name: "tokenAtlas" }], accounts: [{ id: "claude", vendor: "claude" }] };
  const before = JSON.stringify(raw);
  mask.learn(raw);
  const result = mask.text('codex-private · Alice · PRIVATE-PC · alice@example.test · Client [A]+ · secret-repo · C:\\Users\\Alice\\secret.log · /home/alice/logs · 12345678-1234-1234-1234-123456789abc');
  for (const value of ["Alice", "PRIVATE-PC", "codex-private", "example.test", "Client", "secret-repo", "secret.log", "/home", "12345678"]) expect(result).not.toContain(value);
  expect(mask.text("$1,400 · 70% · 2026-09-11 · gpt-6-astra · claude · codex")).toBe("$1,400 · 70% · 2026-09-11 · gpt-6-astra · claude · codex");
  expect(mask.text("tokenAtlas")).toBe("");
  expect(JSON.stringify(raw)).toBe(before);
});

test("leaves blank space instead of inventing account counts, matching only literal identity boundaries", () => {
  const mask = new IdentityMask(); mask.add("team"); mask.add("team-extended");
  const before = mask.text("team-extended / team");
  expect(before).toBe(" / ");
  expect(mask.text("steam teamwork")).toBe("steam teamwork");
  mask.add("another");
  expect(mask.text("team-extended / team")).toBe(before);
});

test("plan names and capacity multipliers remain visible even when encountered in account metadata", () => {
  const mask = new IdentityMask();
  for (const name of ["Pro", "Max 20×", "Pro ×20", "max20x", "codex-pro-20x", "x20", "20x", "Plus"]) {
    mask.learn({ login: name, subscription: name, project: name, note: name });
    expect(mask.text(name)).toBe(name);
  }
  expect(mask.text("Promotion 2× · +100% · 70% = 140% · exceed 40%")).toBe("Promotion 2× · +100% · 70% = 140% · exceed 40%");
});

test("privacy applies to exported strings and toggles off without losing originals", () => {
  const previouslyRenderedName = "tokenatlas-private-client-usage-day.png";
  expect(reportImageFileName(previouslyRenderedName)).toBe(previouslyRenderedName);
  learnPrivacyIdentities({ subscription: "export-private", machine: "hidden-pc" });
  const row = '"export-private";"hidden-pc";"new@example.test";"1,400"';
  expect(privateText(row)).toBe(row);
  setPrivacyEnabled(true);
  expect(reportImageFileName(previouslyRenderedName)).toBe("tokenatlas-private.png");
  const safe = privateText(row);
  expect(safe).not.toContain("export-private"); expect(safe).not.toContain("hidden-pc"); expect(safe).not.toContain("example.test");
  expect(safe).toContain('"1,400"');
  setPrivacyEnabled(false); expect(privateText(row)).toBe(row);
});

test("masked forms cannot save aliases or trigger an external write", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  try {
    setPrivacyEnabled(true);
    await expect(api.plansSave({ subscription: "codex-private", capacity_regimes: [] })).rejects.toThrow("read-only");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});
